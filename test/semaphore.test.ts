import { describe, expect, test } from "bun:test"
import { Semaphore } from "../src/server/runtime/semaphore.js"
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "../src/server/script/limits.js"

const tick = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

describe("Semaphore.clamp", () => {
  test.each([
    [0, MIN_CONCURRENCY],
    [-5, MIN_CONCURRENCY],
    [1, 1],
    [8, 8],
    [MAX_CONCURRENCY + 100, MAX_CONCURRENCY],
    [3.7, 3],
    [Number.NaN, MIN_CONCURRENCY],
    [Number.POSITIVE_INFINITY, MIN_CONCURRENCY],
  ])("clamps %p to %p", (input, expected) => {
    expect(Semaphore.clamp(input)).toBe(expected)
  })

  test("rejecting 0 is the point — `0 ?? 8` is 0 and would hang with no throw", () => {
    const sem = new Semaphore(0)
    expect(sem.limit).toBe(MIN_CONCURRENCY)
  })
})

describe("Semaphore admission", () => {
  test("admits up to the limit immediately", async () => {
    const sem = new Semaphore(3)
    await sem.acquire()
    await sem.acquire()
    await sem.acquire()
    expect(sem.active).toBe(3)
    expect(sem.waiting).toBe(0)
  })

  test("queues beyond the limit and admits on release", async () => {
    const sem = new Semaphore(1),
     first = await sem.acquire()
    let admitted = false
    const pending = sem.acquire().then((release) => {
      admitted = true
      return release
    })

    await tick()
    expect(admitted).toBe(false)
    expect(sem.waiting).toBe(1)

    first()
    await pending
    expect(admitted).toBe(true)
    expect(sem.active).toBe(1)
  })

  test("never exceeds the limit under a burst", async () => {
    const limit = 4,
     sem = new Semaphore(limit)
    let peak = 0,
     running = 0

    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const release = await sem.acquire()
        running++
        peak = Math.max(peak, running)
        await tick()
        running--
        release()
      }),
    )

    expect(peak).toBe(limit)
    expect(sem.active).toBe(0)
    expect(sem.waiting).toBe(0)
  })

  test("a synchronous acquire cannot steal a slot from a woken waiter", async () => {
    // The permit is claimed at wake time inside #drain. If it were claimed after the waiter
    // resumed, an acquire landing in that microtask gap would oversubscribe the limit.
    const sem = new Semaphore(1),
     first = await sem.acquire(),

     queued = sem.acquire()
    first()
    const sneaky = sem.acquire()

    await queued
    expect(sem.active).toBe(1)
    expect(sem.waiting).toBe(1)
    void sneaky
  })

  test("release is idempotent", async () => {
    const sem = new Semaphore(2),
     release = await sem.acquire()
    release()
    release()
    release()
    expect(sem.active).toBe(0)
  })

  test("waiters are admitted in FIFO order", async () => {
    const sem = new Semaphore(1),
     held = await sem.acquire(),
     order: number[] = [],

     waiters = [1, 2, 3].map(async (n) => {
      const release = await sem.acquire()
      order.push(n)
      release()
    })

    held()
    await Promise.all(waiters)
    expect(order).toEqual([1, 2, 3])
  })
})

describe("Semaphore.resize", () => {
  test("raising the limit admits queued waiters", async () => {
    const sem = new Semaphore(1)
    await sem.acquire()
    const queued = sem.acquire()
    await tick()
    expect(sem.waiting).toBe(1)

    sem.resize(2)
    await queued
    expect(sem.active).toBe(2)
  })

  test("lowering the limit does not revoke in-flight permits", async () => {
    const sem = new Semaphore(4)
    await sem.acquire()
    await sem.acquire()
    await sem.acquire()
    expect(sem.active).toBe(3)

    sem.resize(1)
    expect(sem.limit).toBe(1)
    // Still 3 in flight: throttling slows admission, it never interrupts a running agent.
    expect(sem.active).toBe(3)
  })

  test("resize clamps like the constructor", () => {
    const sem = new Semaphore(4)
    sem.resize(0)
    expect(sem.limit).toBe(MIN_CONCURRENCY)
    sem.resize(9999)
    expect(sem.limit).toBe(MAX_CONCURRENCY)
  })
})

describe("Semaphore — pause and resume", () => {
  test("pause blocks new acquisitions; in-flight permits are untouched", async () => {
    const gate = new Semaphore(2)
    const permits = [await gate.acquire(), await gate.acquire()]
    gate.pause()
    expect(gate.paused).toBe(true)
    let acquired = false
    void gate.acquire().then((release) => {
      acquired = true
      return release
    })
    await Promise.resolve()
    expect(acquired).toBe(false)
    // In-flight permits are never revoked by the pause.
    expect(gate.active).toBe(2)
    // Resume opens the drain, but a waiter is admitted only when a permit is
    // RELEASED — in-flight work is never revoked.
    permits.at(0)?.()
    gate.resume()
    await Bun.sleep(1)
    expect(gate.paused).toBe(false)
    expect(acquired).toBe(true)
    permits.at(1)?.()
  })

  test("a paused gate queues in FIFO order; resume releases in order", async () => {
    const gate = new Semaphore(1)
    const first = await gate.acquire()
    gate.pause()
    const order: number[] = []
    const waiters = [gate.acquire().then((r) => {order.push(1); return r()}), gate.acquire().then((r) => {order.push(2); return r()})]
    first()
    gate.resume()
    await Promise.all(waiters)
    expect(order).toEqual([1, 2])
  })

  test("resume with nothing queued is a no-op that does not oversubscribe", async () => {
    const gate = new Semaphore(1)
    const permit = await gate.acquire()
    gate.pause()
    gate.resume()
    gate.resume()
    expect(gate.active).toBe(1)
    permit()
    expect(gate.active).toBe(0)
  })
})
