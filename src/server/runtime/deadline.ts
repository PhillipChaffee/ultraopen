/**
 * Wall-clock deadlines for agent runs.
 *
 * MANDATORY, not an optimisation. opencode retries provider failures with no attempt cap
 * (`session/processor.ts` wraps the step in `Effect.retry` and `session/retry.ts` exits only when
 * the error is non-retryable). On the ordinary headers-present path the backoff is capped only by
 * `RETRY_MAX_DELAY = 2_147_483_647`ms — about 24.8 days. Combined with the plugin client's
 * `req.timeout = false`, a single rate-limited agent would hold a concurrency permit forever, and
 * `budget()` is token-based so it cannot see idle retry sleep.
 */

export class DeadlineExceededError extends Error {
  readonly ms: number

  constructor(ms: number, label: string) {
    super(`Agent "${label}" exceeded its ${Math.round(ms / 1000)}s deadline and was abandoned.`)
    this.name = "DeadlineExceededError"
    this.ms = ms
  }
}

export type DeadlineOptions = {
  ms: number
  label: string
  /** Invoked exactly once if the deadline fires, before the returned promise rejects. */
  onTimeout?: (() => void | Promise<void>) | undefined
  /** Injectable for tests. Defaults to the global timer. */
  timers?:
    | {
        setTimeout: (fn: () => void, ms: number) => unknown
        clearTimeout: (handle: unknown) => void
      }
    | undefined
}

/**
 * Races `work` against a wall-clock deadline.
 *
 * On expiry the returned promise rejects with DeadlineExceededError and `onTimeout` fires (used to
 * abort the child session server-side). The underlying work is NOT cancelled by this function —
 * JavaScript promises are not cancellable — so `onTimeout` is what actually stops the remote run.
 * The timer is always cleared, so a settled call never keeps the event loop alive.
 */
export async function withDeadline<T>(work: Promise<T>, options: DeadlineOptions): Promise<T> {
  // Adapters rather than the raw globals: the injectable shape deliberately uses an opaque
  // `unknown` handle so tests can hand back a plain number, which the platform types reject.
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
    },
  }

  let handle: unknown
  let fired = false

  const timeout = new Promise<never>((_resolve, reject) => {
    handle = timers.setTimeout(() => {
      fired = true
      reject(new DeadlineExceededError(options.ms, options.label))
    }, options.ms)
  })

  try {
    const raced = Promise.race([work, timeout])
    // If the deadline wins, the abandoned work promise may still reject later (the SDK's fetch
    // layer throws on transport errors). With no handler that is an unhandled rejection, which
    // Node treats as fatal — one slow agent would take the whole opencode server down.
    void work.catch(() => {})
    return await raced
  } finally {
    timers.clearTimeout(handle)
    if (fired && options.onTimeout) {
      // Fire-and-forget: cleanup failure must not mask the deadline error.
      void Promise.resolve(options.onTimeout()).catch(() => {})
    }
  }
}
