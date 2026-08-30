import { beforeEach, describe, expect, test } from "bun:test"
import { registry } from "../src/server/singleton.js"
import { MIN_CONCURRENCY } from "../src/server/script/limits.js"

// registry is process-wide (module-level) state by design — see the file's own doc comment — so
// every test must start from a clean slate or bleed into the next one.
beforeEach(() => {
  registry.resetForTests()
})

describe("registry.register / owns / forget", () => {
  test("a registered session is owned", () => {
    registry.register("s1", "run-a")
    expect(registry.owns("s1")).toBe(true)
  })

  test("an unregistered session is not owned", () => {
    expect(registry.owns("unknown")).toBe(false)
  })

  test("forget releases ownership", () => {
    registry.register("s1", "run-a")
    registry.forget("s1")
    expect(registry.owns("s1")).toBe(false)
  })

  test("forgetting a session that was never registered is a no-op, not a throw", () => {
    expect(() => registry.forget("never-registered")).not.toThrow()
  })
})

describe("registry.runOf", () => {
  test("returns the owning run for a registered session", () => {
    registry.register("s1", "run-a")
    expect(registry.runOf("s1")).toBe("run-a")
  })

  test("returns undefined for a session that was never registered", () => {
    expect(registry.runOf("unknown")).toBeUndefined()
  })

  test("returns undefined after the session is forgotten", () => {
    registry.register("s1", "run-a")
    registry.forget("s1")
    expect(registry.runOf("s1")).toBeUndefined()
  })
})

describe("registry.sessionsOf", () => {
  test("returns only the sessions belonging to the asked-for run", () => {
    registry.register("s1", "run-a")
    registry.register("s2", "run-a")
    registry.register("s3", "run-b")
    expect(registry.sessionsOf("run-a").toSorted()).toEqual(["s1", "s2"])
  })

  test("returns an empty array for an unknown run", () => {
    registry.register("s1", "run-a")
    expect(registry.sessionsOf("run-does-not-exist")).toEqual([])
  })
})

describe("registry.size", () => {
  test("counts owned sessions, not runs", () => {
    registry.register("s1", "run-a")
    registry.register("s2", "run-a")
    expect(registry.size).toBe(2)
  })

  test("drops on forget", () => {
    registry.register("s1", "run-a")
    registry.forget("s1")
    expect(registry.size).toBe(0)
  })

  test("is zero on a fresh registry", () => {
    expect(registry.size).toBe(0)
  })
})

describe("registry.configureConcurrency", () => {
  test("clamps out-of-range input — 0 becomes the minimum, not a hang with no throw", () => {
    registry.configureConcurrency(0)
    expect(registry.semaphore.limit).toBe(MIN_CONCURRENCY)
  })

  test("applies an in-range value", () => {
    registry.configureConcurrency(3)
    expect(registry.semaphore.limit).toBe(3)
  })

  test("setting the same value twice is a no-op — the second call does not replace the instance", () => {
    registry.configureConcurrency(3)
    const before = registry.semaphore
    registry.configureConcurrency(3)
    expect(registry.semaphore).toBe(before)
  })

  test("a different value does replace the live limit", () => {
    registry.configureConcurrency(3)
    registry.configureConcurrency(5)
    expect(registry.semaphore.limit).toBe(5)
  })
})

describe("registry.semaphore", () => {
  test("is a live shared instance — acquiring through it is visible on every read", async () => {
    await registry.semaphore.acquire()
    expect(registry.semaphore.active).toBe(1)
  })

  test("resetForTests swaps in a fresh semaphore, dropping any in-flight state", async () => {
    await registry.semaphore.acquire()
    registry.resetForTests()
    expect(registry.semaphore.active).toBe(0)
  })
})
