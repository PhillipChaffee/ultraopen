/**
 * Wall-clock and inactivity deadlines for agent runs.
 *
 * The idle bound is the PRIMARY runaway backstop, not an optimisation. opencode retries provider
 * failures with no attempt cap (`session/processor.ts` wraps the step in `Effect.retry` and
 * `session/retry.ts` exits only when the error is non-retryable). On the ordinary headers-present
 * path the backoff is capped only by `RETRY_MAX_DELAY = 2_147_483_647`ms — about 24.8 days.
 * Combined with the plugin client's `req.timeout = false`, a single rate-limited agent would hold
 * a concurrency permit forever, and `budget()` is token-based so it cannot see idle retry sleep.
 * A stalled agent produces no events, so the idle timer catches it within minutes; the wall clock
 * only bounds an agent that keeps producing forever without finishing.
 */

export class DeadlineExceededError extends Error {
  readonly ms: number
  /** Distinguishes the two kill shapes: an idle kill is restartable, a wall-clock kill is not. */
  readonly kind: "wall-clock" | "idle"

  constructor(ms: number, label: string, message?: string, kind: "wall-clock" | "idle" = "wall-clock") {
    super(message ?? `Agent "${label}" exceeded its ${Math.round(ms / 1000)}s deadline and was abandoned.`)
    this.name = "DeadlineExceededError"
    this.ms = ms
    this.kind = kind
  }
}

export interface DeadlineOptions {
  ms: number
  label: string
  /** Invoked exactly once if the deadline fires, before the returned promise rejects. */
  onTimeout?: (() => void | Promise<void>) | undefined
  /** Injectable for tests. Defaults to the global timer. */
  timers?:
    | {
        setTimeout: (fn: () => void, ms: number) => unknown
        clearTimeout: (handle: unknown) => void
        /** Injectable for tests; defaults to Date.now. Drives the idle re-arm arithmetic. */
        now?: () => number
      }
    | undefined
  /** Inactivity window in ms. 0 or absent disables the idle bound. */
  idleMs?: number | undefined
  /**
   * Returns the epoch ms of the child's last observed progress. Re-checked each time the idle
   * timer fires: newer progress re-arms the timer, older means the agent is idle.
   */
  activity?: (() => number) | undefined
}

/**
 * Races `work` against two bounds: a wall-clock deadline and an inactivity bound.
 *
 * On expiry the returned promise rejects with DeadlineExceededError, carrying the wall-clock or
 * idle message respectively,
 * and `onTimeout` fires (used to abort the child session server-side). The underlying work is NOT
 * cancelled by this function — JavaScript promises are not cancellable — so `onTimeout` is what
 * actually stops the remote run. The timers are always cleared, so a settled call never keeps the
 * event loop alive.
 *
 * `ms === 0` disables the wall clock entirely; the idle bound then stands alone. The idle bound is
 * armed only when both `idleMs > 0` and an `activity` probe are supplied, so a call site that
 * cannot observe progress keeps the wall clock as its sole bound rather than silently idling out.
 * The idle timer re-arms from the LAST PROGRESS time whenever it fires and progress is newer than
 * its schedule, so any event inside the window resets it.
 */
export async function withDeadline<T>(work: Promise<T>, options: DeadlineOptions): Promise<T> {
  // Adapters rather than the raw globals: the injectable shape deliberately uses an opaque
  // `unknown` handle so tests can hand back a plain number, which the platform types reject.
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number): unknown => globalThis.setTimeout(fn, ms),
    clearTimeout: (handle: unknown): void => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
    },
  },
   now = options.timers?.now ?? Date.now,
   idle = options.idleMs !== undefined && options.idleMs > 0 ? options.idleMs : 0,
   observeIdle = idle > 0 && options.activity !== undefined

  let handle: unknown,
   idleHandle: unknown,
   fired = false,
   lastProgress = now()

  // Only armed when ms > 0; `0` means "idle bound stands alone".
  const wallClock = new Promise<never>((_resolve, reject) => {
    if (options.ms > 0) {
      handle = timers.setTimeout(() => {
        fired = true
        reject(new DeadlineExceededError(options.ms, options.label))
      }, options.ms)
    }
  })

  let rejectIdle!: (error: DeadlineExceededError) => void
  const idleBound = new Promise<never>((_resolve, reject) => {
    // Assigned synchronously by the executor, so checkIdle can never see it unset.
    rejectIdle = reject
  })
  const checkIdle = (): void => {
    const touched = options.activity?.() ?? 0
    if (touched > lastProgress) {
      lastProgress = touched
      // Re-arm from the last progress, not from the fire time: progress that landed between
      // schedule and fire still buys the agent its full window back.
      idleHandle = timers.setTimeout(checkIdle, Math.max(0, idle - (now() - lastProgress)))
      return
    }
    fired = true
    rejectIdle(new DeadlineExceededError(idle, options.label, `Agent "${options.label}" made no progress for ${Math.round(idle / 1000)}s and was abandoned.`, "idle"))
  }
  if (observeIdle) {
    idleHandle = timers.setTimeout(checkIdle, idle)
  }

  const racers: Promise<T | never>[] = [work, wallClock]
  if (observeIdle) {racers.push(idleBound)}

  try {
    const raced = Promise.race(racers)
    // If a bound wins, the abandoned work promise may still reject later (the SDK's fetch layer
    // throws on transport errors). With no handler that is an unhandled rejection, which Node
    // treats as fatal — one slow agent would take the whole opencode server down.
    void work.catch(() => {})
    void idleBound.catch(() => {})
    return await raced
  } finally {
    timers.clearTimeout(handle)
    if (idleHandle !== undefined) {timers.clearTimeout(idleHandle)}
    if (fired && options.onTimeout) {
      // Fire-and-forget: cleanup failure must not mask the deadline error.
      void Promise.resolve(options.onTimeout()).catch(() => {})
    }
  }
}