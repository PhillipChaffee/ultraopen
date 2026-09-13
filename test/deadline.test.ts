import { describe, expect, test } from "bun:test"
import { DeadlineExceededError, withDeadline } from "../src/server/runtime/deadline.js"

/** A controllable clock, so deadline tests are instant and deterministic. */
function fakeTimers() {
  let next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  return {
    api: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, { fn, ms })
        return id
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number)
      },
    },
    fireAll: () => {
      // Snapshot then clear: a fired callback may schedule another timer, which must not run
      // in this same pass.
      const due = [...pending.values()]
      pending.clear()
      for (const entry of due) {entry.fn()}
    },
    get size() {
      return pending.size
    },
  }
}

describe("withDeadline", () => {
  test("passes through a value when work wins", async () => {
    const timers = fakeTimers(),
     result = await withDeadline(Promise.resolve("ok"), { ms: 1000, label: "a", timers: timers.api })
    expect(result).toBe("ok")
  })

  test("clears the timer so a settled call cannot keep the loop alive", async () => {
    const timers = fakeTimers()
    await withDeadline(Promise.resolve(1), { ms: 1000, label: "a", timers: timers.api })
    expect(timers.size).toBe(0)
  })

  test("propagates a rejection from the work itself", async () => {
    const timers = fakeTimers(),
     promise = withDeadline(Promise.reject(new Error("boom")), { ms: 1000, label: "a", timers: timers.api })
    await expect(promise).rejects.toThrow("boom")
    expect(timers.size).toBe(0)
  })

  test("rejects with DeadlineExceededError when the deadline fires", async () => {
    const timers = fakeTimers(),
     promise = withDeadline(new Promise(() => {}), { ms: 900_000, label: "verify:jwt", timers: timers.api })
    timers.fireAll()
    await expect(promise).rejects.toThrow(DeadlineExceededError)
    await expect(promise).rejects.toThrow(/verify:jwt/u)
    await expect(promise).rejects.toThrow(/900s deadline/u)
  })

  test("invokes onTimeout so the remote run is actually aborted", async () => {
    const timers = fakeTimers()
    let aborted = false
    const promise = withDeadline(new Promise(() => {}), {
      ms: 1000,
      label: "a",
      timers: timers.api,
      onTimeout: () => {
        aborted = true
      },
    })
    timers.fireAll()
    await expect(promise).rejects.toThrow(DeadlineExceededError)
    await Promise.resolve()
    expect(aborted).toBe(true)
  })

  test("does NOT invoke onTimeout when the work wins", async () => {
    const timers = fakeTimers()
    let aborted = false
    await withDeadline(Promise.resolve(1), {
      ms: 1000,
      label: "a",
      timers: timers.api,
      onTimeout: () => {
        aborted = true
      },
    })
    expect(aborted).toBe(false)
  })

  test("a failing onTimeout does not mask the deadline error", async () => {
    const timers = fakeTimers(),
     promise = withDeadline(new Promise(() => {}), {
      ms: 1000,
      label: "a",
      timers: timers.api,
      onTimeout: () => Promise.reject(new Error("abort failed")),
    })
    timers.fireAll()
    await expect(promise).rejects.toThrow(DeadlineExceededError)
  })

  test("carries the configured ms on the error for logging", async () => {
    const timers = fakeTimers(),
     promise = withDeadline(new Promise(() => {}), { ms: 4242, label: "a", timers: timers.api })
    timers.fireAll()
    await expect(promise).rejects.toMatchObject({ ms: 4242, name: "DeadlineExceededError" })
  })

  test("a rejection arriving AFTER the deadline wins is consumed, not unhandled", async () => {
    // The abandoned work promise still rejects later (the SDK's fetch layer throws on transport
    // errors). Without a handler that is an unhandled rejection, which Node treats as fatal —
    // one slow agent would crash the whole opencode server.
    const timers = fakeTimers(),
     unhandled: unknown[] = [],
     onUnhandled = (error: unknown) => unhandled.push(error),
    // Bun's Process typing omits the Node rejection event; the runtime supports it.
     emitter = process as unknown as {
      on: (event: "unhandledRejection", listener: (error: unknown) => void) => void
      off: (event: "unhandledRejection", listener: (error: unknown) => void) => void
    }
    emitter.on("unhandledRejection", onUnhandled)
    try {
      let rejectWork!: (error: unknown) => void
      const work = new Promise<never>((_resolve, reject) => {
        rejectWork = reject
      }),
       promise = withDeadline(work, { ms: 1000, label: "a", timers: timers.api })
      timers.fireAll()
      await expect(promise).rejects.toThrow(DeadlineExceededError)
      rejectWork(new Error("late transport failure"))
      // Drain microtasks so any unhandled-rejection bookkeeping would have fired.
      await Promise.resolve()
      await Promise.resolve()
      expect(unhandled).toEqual([])
    } finally {
      emitter.off("unhandledRejection", onUnhandled)
    }
  })

  test("uses the global timer when none is injected", async () => {
    // Small real delay: proves the default path works without a fake clock.
    const promise = withDeadline(new Promise(() => {}), { ms: 5, label: "real" })
    await expect(promise).rejects.toThrow(DeadlineExceededError)
  })
})

/**
 * A clock-aware fake: `now` is injectable, so the idle re-arm arithmetic (remaining =
 * idle - (now - lastProgress)) is deterministic without real waits. Built standalone rather than
 * spread from fakeTimers — spreading would snapshot the `size` getter into a static number.
 */
function idleTimers() {
  let clock = 0,
   next = 1
  const pending = new Map<number, { fn: () => void; ms: number }>()
  return {
    api: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, { fn, ms })
        return id
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number)
      },
      now: () => clock,
    },
    advance: (ms: number) => {
      clock += ms
    },
    fireAll: () => {
      // Snapshot then clear: a fired callback may schedule another timer, which must not run
      // in this same pass.
      const due = [...pending.values()]
      pending.clear()
      for (const entry of due) {entry.fn()}
    },
    get size() {
      return pending.size
    },
  }
}

describe("withDeadline — idle bound", () => {
  test("rejects with the idle message when no progress is observed", async () => {
    const timers = idleTimers(),
     promise = withDeadline(new Promise(() => {}), {
      ms: 0,
      idleMs: 1000,
      activity: () => 0,
      label: "stalled",
      timers: timers.api,
    })
    timers.advance(1000)
    timers.fireAll()
    await expect(promise).rejects.toThrow(DeadlineExceededError)
    await expect(promise).rejects.toThrow(/made no progress/u)
    await expect(promise).rejects.toThrow(/\b1s/u)
  })

  test("re-arms when progress lands inside the window, then fires when activity stops", async () => {
    const timers = idleTimers()
    let touchedAt = 0
    const promise = withDeadline(new Promise(() => {}), {
      ms: 0,
      idleMs: 1000,
      activity: () => touchedAt,
      label: "a",
      timers: timers.api,
    })
    // The timer was armed at t=0 for 1000. Progress lands at t=300, so the fire at t=1000 must
    // re-arm for the remaining 700 rather than fire.
    timers.advance(1000)
    touchedAt = 300
    timers.fireAll()
    await Promise.resolve()
    expect(timers.size).toBe(1)
    // No further progress: the re-armed timer fires at t=1700 and the idle bound rejects.
    timers.advance(700)
    timers.fireAll()
    await expect(promise).rejects.toThrow(/made no progress/u)
  })

  test("does not arm the idle bound without an activity probe", async () => {
    const timers = idleTimers()
    await withDeadline(Promise.resolve(1), { ms: 5000, idleMs: 1000, label: "a", timers: timers.api })
    // Only the wall clock was armed and cleared; no idle timer ever existed.
    expect(timers.size).toBe(0)
  })

  test("ms 0 disables the wall clock so the idle bound stands alone", async () => {
    const timers = idleTimers(),
     promise = withDeadline(new Promise(() => {}), {
      ms: 0,
      idleMs: 1000,
      activity: () => 0,
      label: "a",
      timers: timers.api,
    })
    expect(timers.size).toBe(1)
    timers.advance(1000)
    timers.fireAll()
    await expect(promise).rejects.toThrow(/made no progress/u)
  })

  test("a settled call clears both timers", async () => {
    const timers = idleTimers()
    await withDeadline(Promise.resolve(1), {
      ms: 5000,
      idleMs: 1000,
      activity: () => 0,
      label: "a",
      timers: timers.api,
    })
    expect(timers.size).toBe(0)
  })

  test("onTimeout fires on idle expiry so the child is actually aborted", async () => {
    const timers = idleTimers()
    let aborted = false
    const promise = withDeadline(new Promise(() => {}), {
      ms: 0,
      idleMs: 1000,
      activity: () => 0,
      label: "a",
      timers: timers.api,
      onTimeout: () => {
        aborted = true
      },
    })
    timers.advance(1000)
    timers.fireAll()
    await expect(promise).rejects.toThrow(DeadlineExceededError)
    await Promise.resolve()
    expect(aborted).toBe(true)
  })

  test("an idle-bound rejection arriving later does not become unhandled", async () => {
    // The idle promise is raced but may settle after the work already won; it must not leak.
    const timers = idleTimers()
    await withDeadline(Promise.resolve(1), {
      ms: 0,
      idleMs: 1000,
      activity: () => 0,
      label: "a",
      timers: timers.api,
    })
    timers.advance(1000)
    timers.fireAll()
    await Promise.resolve()
  })
})
