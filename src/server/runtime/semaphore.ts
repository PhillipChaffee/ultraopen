import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "../script/limits.js"

/**
 * A counting semaphore with an adjustable limit and FIFO waiters.
 *
 * Gates AGENT SPAWNS ONLY. Combinator work items (`parallel` thunks, `pipeline` stages) must NOT
 * pass through this gate: a `parallel` nested inside a `pipeline` stage would deadlock, because
 * the outer item holds a permit while its inner thunks wait for one.
 *
 * Hand-rolled because opencode's own KeyedMutex lives behind `"private": true` and its queue
 * utility is unexported.
 */
export class Semaphore {
  #limit: number
  #active = 0
  readonly #waiters: Waiter[] = []

  constructor(limit: number) {
    this.#limit = Semaphore.clamp(limit)
  }

  /**
   * Clamps a requested limit into range.
   *
   * Rejecting 0 matters: `0 ?? 8` is `0`, and a limit below 1 makes every acquire wait forever —
   * a hang with no throw, no log and no progress.
   */
  static clamp(limit: number): number {
    if (!Number.isFinite(limit)) return MIN_CONCURRENCY
    return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(limit)))
  }

  get limit(): number {
    return this.#limit
  }

  get active(): number {
    return this.#active
  }

  get waiting(): number {
    return this.#waiters.length
  }

  /** Resolves when a permit is available. The returned function releases it exactly once. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortedError()
    if (this.#active < this.#limit) {
      this.#active++
      return this.#releaser()
    }
    // The permit is claimed by #drain at wake time, NOT here. If the waiter incremented after
    // resuming, a synchronous acquire() landing in the microtask gap between resolve() and that
    // resumption would see a free slot and oversubscribe the limit.
    const entry = {} as Waiter
    const gate = new Promise<void>((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    if (signal) {
      // An aborted run must not spend its remaining lifetime queued for a permit it would
      // immediately waste on a child session.
      entry.signal = signal
      entry.onAbort = () => {
        const index = this.#waiters.indexOf(entry)
        if (index >= 0) this.#waiters.splice(index, 1)
        entry.reject(abortedError())
      }
      signal.addEventListener("abort", entry.onAbort, { once: true })
    }
    this.#waiters.push(entry)
    try {
      await gate
    } finally {
      // The waiter left the queue one way or another; the abort listener must not outlive it.
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort)
    }
    return this.#releaser()
  }

  #releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active--
      this.#drain()
    }
  }

  /**
   * Changes the limit at runtime.
   *
   * Lowering it never revokes an in-flight permit — it only slows admission — so an active agent
   * is never interrupted by a throttle decision.
   */
  resize(limit: number): void {
    this.#limit = Semaphore.clamp(limit)
    this.#drain()
  }

  #drain(): void {
    while (this.#active < this.#limit && this.#waiters.length > 0) {
      const next = this.#waiters.shift()
      if (!next) continue
      this.#active++
      next.resolve()
    }
  }
}

type Waiter = {
  resolve: () => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: (() => void) | undefined
}

function abortedError(): Error {
  const error = new Error("The run was aborted while this agent was waiting for a concurrency permit.")
  error.name = "AbortError"
  return error
}
