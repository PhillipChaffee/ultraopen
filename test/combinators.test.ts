import { describe, expect, test } from "bun:test"
import { parallel, pipeline } from "../src/server/runtime/combinators.js"
import { MAX_ITEMS_PER_CALL } from "../src/server/script/limits.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

describe("parallel", () => {
  test("resolves in array order even when thunks settle out of order", async () => {
    const results = await parallel([
      async () => {
        await wait(30)
        return 0
      },
      async () => {
        await wait(10)
        return 1
      },
      () => 2,
    ])
    expect(results).toEqual([0, 1, 2])
  })

  test("runs concurrently rather than sequentially", async () => {
    let running = 0
    let peak = 0
    const thunk = async () => {
      running++
      peak = Math.max(peak, running)
      await wait(10)
      running--
      return "done"
    }

    await parallel([thunk, thunk, thunk])
    expect(peak).toBeGreaterThan(1)
  })

  test("a thunk that returns a rejected promise resolves to null, and the call does not reject", async () => {
    const rejected = Promise.reject(new Error("boom"))
    const results = await parallel([() => rejected, () => 1])
    expect(results).toEqual([null, 1])
  })

  test("a thunk that throws synchronously also resolves to null", async () => {
    const results = await parallel([
      () => {
        throw new Error("x")
      },
      () => 1,
    ])
    expect(results).toEqual([null, 1])
  })

  test("a non-function entry resolves to null rather than rejecting the barrier", async () => {
    const notAThunk = Promise.resolve(1) as unknown as () => unknown
    const results = await parallel([notAThunk, () => 2])
    expect(results).toEqual([null, 2])
  })

  test("passing a non-array throws a TypeError naming the authoring mistake", async () => {
    // parallel() is an `async function`, so a synchronous throw inside it surfaces as a
    // rejected promise, not a synchronous throw from the call site — must await it.
    const notAnArray = Promise.resolve([1, 2, 3]) as unknown as ReadonlyArray<() => unknown>
    try {
      await parallel(notAnArray)
      throw new Error("expected parallel() to reject")
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError)
      const message = (error as TypeError).message
      expect(message).toContain("not promises")
      expect(message).toContain("() => agent(...)")
    }
  })

  test("an empty array resolves to []", async () => {
    const results = await parallel([])
    expect(results).toEqual([])
  })

  test("exactly MAX_ITEMS_PER_CALL items is allowed", async () => {
    const thunks = Array.from({ length: MAX_ITEMS_PER_CALL }, () => () => 1)
    const results = await parallel(thunks)
    expect(results.length).toBe(MAX_ITEMS_PER_CALL)
  })

  test("MAX_ITEMS_PER_CALL + 1 throws an explicit error naming the limit, not silent truncation", async () => {
    const thunks = Array.from({ length: MAX_ITEMS_PER_CALL + 1 }, () => () => 1)
    await expect(parallel(thunks)).rejects.toThrow(String(MAX_ITEMS_PER_CALL))
  })
})

describe("pipeline", () => {
  test("a single stage maps each item", async () => {
    const results = await pipeline([1, 2, 3], (_prev, item) => (item as number) * 2)
    expect(results).toEqual([2, 4, 6])
  })

  test("multiple stages chain: stage N receives the previous stage's return value", async () => {
    const results = await pipeline(
      [1],
      (prev) => (prev as number) + 1,
      (prev) => (prev as number) * 10,
    )
    expect(results).toEqual([20])
  })

  test("every stage receives (prev, originalItem, index) with the ORIGINAL item, not the previous result", async () => {
    const seen: Array<{ prev: unknown; item: unknown; index: number }> = []
    await pipeline(
      ["a", "b"],
      (prev, item, index) => {
        seen.push({ prev, item, index })
        return "stage1"
      },
      (prev, item, index) => {
        seen.push({ prev, item, index })
        return "stage2"
      },
    )

    expect(seen).toEqual([
      { prev: "a", item: "a", index: 0 },
      { prev: "b", item: "b", index: 1 },
      { prev: "stage1", item: "a", index: 0 },
      { prev: "stage1", item: "b", index: 1 },
    ])
  })

  test("no barrier between stages: a fast item's later stage can start before a slow item's earlier stage ends", async () => {
    const log: string[] = []

    const results = await pipeline(
      ["A", "B"],
      async (_prev, item) => {
        log.push(`${item as string}:s1:start`)
        await wait(item === "A" ? 5 : 40)
        log.push(`${item as string}:s1:end`)
        return item
      },
      (_prev, item) => {
        log.push(`${item as string}:s2:start`)
        return item
      },
    )

    expect(results).toEqual(["A", "B"])
    const a2Start = log.indexOf("A:s2:start")
    const bEnd = log.indexOf("B:s1:end")
    expect(a2Start).toBeGreaterThanOrEqual(0)
    expect(bEnd).toBeGreaterThanOrEqual(0)
    expect(a2Start).toBeLessThan(bEnd)
  })

  test("a stage that throws drops the item to null and later stages never run", async () => {
    let stage3Calls = 0
    const results = await pipeline(
      [1, 2],
      (_prev, item) => {
        if (item === 1) throw new Error("boom")
        return item
      },
      (prev) => prev,
      (prev) => {
        stage3Calls++
        return prev
      },
    )
    expect(results).toEqual([null, 2])
    // Only item 2 should have reached stage 3.
    expect(stage3Calls).toBe(1)
  })

  // agent() returns null on skip or terminal failure, so without this every ported script would
  // crash on `null.findings`.
  test("a stage that returns null drops the item to null and skips remaining stages", async () => {
    let stage3Calls = 0
    const results = await pipeline(
      [1, 2],
      (_prev, item) => (item === 1 ? null : item),
      (prev) => prev,
      (prev) => {
        stage3Calls++
        return prev
      },
    )
    expect(results).toEqual([null, 2])
    expect(stage3Calls).toBe(1)
  })

  test("a stage that returns undefined behaves the same as null", async () => {
    let stage3Calls = 0
    const results = await pipeline(
      [1, 2],
      (_prev, item) => (item === 1 ? undefined : item),
      (prev) => prev,
      (prev) => {
        stage3Calls++
        return prev
      },
    )
    expect(results).toEqual([null, 2])
    expect(stage3Calls).toBe(1)
  })

  test("one item failing does not affect the others", async () => {
    const results = await pipeline(
      [1, 2, 3],
      (_prev, item) => {
        if (item === 2) throw new Error("boom")
        return (item as number) * 10
      },
    )
    expect(results).toEqual([10, null, 30])
  })

  test("zero stages returns the items unchanged", async () => {
    const results = await pipeline([1, 2, 3])
    expect(results).toEqual([1, 2, 3])
  })

  test("an empty items array returns []", async () => {
    const results = await pipeline([], (prev) => prev)
    expect(results).toEqual([])
  })

  test("passing a non-array as items throws a TypeError", async () => {
    // pipeline() is also an `async function` — same synchronous-throw-becomes-rejection caveat.
    const notAnArray = Promise.resolve([1, 2]) as unknown as readonly unknown[]
    await expect(pipeline(notAnArray, (prev) => prev)).rejects.toThrow(TypeError)
  })

  test("exactly MAX_ITEMS_PER_CALL items is allowed", async () => {
    const items = Array.from({ length: MAX_ITEMS_PER_CALL }, (_unused, index) => index)
    const results = await pipeline(items, (prev) => prev)
    expect(results.length).toBe(MAX_ITEMS_PER_CALL)
  })

  test("MAX_ITEMS_PER_CALL + 1 throws with the limit in the message", async () => {
    const items = Array.from({ length: MAX_ITEMS_PER_CALL + 1 }, (_unused, index) => index)
    await expect(pipeline(items, (prev) => prev)).rejects.toThrow(String(MAX_ITEMS_PER_CALL))
  })
})

describe("engine faults are never swallowed", () => {
  const tooMany = Array.from({ length: MAX_ITEMS_PER_CALL + 1 }, () => () => 1)

  test("a LimitError inside a pipeline stage propagates instead of becoming null", async () => {
    // Regression: both combinators catch broadly to degrade a failed agent to null. Without an
    // explicit re-throw for engine faults, blowing the 4096-item cap inside a stage would surface
    // as "that item produced nothing" — exactly the silent truncation the spec forbids.
    await expect(pipeline([1], async () => await parallel(tooMany))).rejects.toThrow(WorkflowScriptError)
  })

  test("a LimitError inside a parallel thunk propagates", async () => {
    await expect(parallel([async () => await parallel(tooMany)])).rejects.toThrow(WorkflowScriptError)
  })

  test("ordinary failures still degrade to null", async () => {
    expect(
      await parallel([
        () => {
          throw new Error("boom")
        },
      ]),
    ).toEqual([null])
    expect(
      await pipeline([1], () => {
        throw new Error("boom")
      }),
    ).toEqual([null])
  })
})
