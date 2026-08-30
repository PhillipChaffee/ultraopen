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
      for (const entry of due) entry.fn()
    },
    get size() {
      return pending.size
    },
  }
}

describe("withDeadline", () => {
  test("passes through a value when work wins", async () => {
    const timers = fakeTimers()
    const result = await withDeadline(Promise.resolve("ok"), { ms: 1000, label: "a", timers: timers.api })
    expect(result).toBe("ok")
  })

  test("clears the timer so a settled call cannot keep the loop alive", async () => {
    const timers = fakeTimers()
    await withDeadline(Promise.resolve(1), { ms: 1000, label: "a", timers: timers.api })
    expect(timers.size).toBe(0)
  })

  test("propagates a rejection from the work itself", async () => {
    const timers = fakeTimers()
    const promise = withDeadline(Promise.reject(new Error("boom")), { ms: 1000, label: "a", timers: timers.api })
    await expect(promise).rejects.toThrow("boom")
    expect(timers.size).toBe(0)
  })

  test("rejects with DeadlineExceededError when the deadline fires", async () => {
    const timers = fakeTimers()
    const promise = withDeadline(new Promise(() => {}), { ms: 900_000, label: "verify:jwt", timers: timers.api })
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
    const timers = fakeTimers()
    const promise = withDeadline(new Promise(() => {}), {
      ms: 1000,
      label: "a",
      timers: timers.api,
      onTimeout: () => Promise.reject(new Error("abort failed")),
    })
    timers.fireAll()
    await expect(promise).rejects.toThrow(DeadlineExceededError)
  })

  test("carries the configured ms on the error for logging", async () => {
    const timers = fakeTimers()
    const promise = withDeadline(new Promise(() => {}), { ms: 4242, label: "a", timers: timers.api })
    timers.fireAll()
    await expect(promise).rejects.toMatchObject({ ms: 4242, name: "DeadlineExceededError" })
  })

  test("uses the global timer when none is injected", async () => {
    // Small real delay: proves the default path works without a fake clock.
    const promise = withDeadline(new Promise(() => {}), { ms: 5, label: "real" })
    await expect(promise).rejects.toThrow(DeadlineExceededError)
  })
})
