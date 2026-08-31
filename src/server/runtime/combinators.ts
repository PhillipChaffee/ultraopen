import { fail, WorkflowScriptError } from "../script/errors.js"
import { MAX_ITEMS_PER_CALL } from "../script/limits.js"
import { openFrame, withChildScope } from "../resume/scope.js"

/**
 * `parallel` and `pipeline`, the two fan-out primitives a workflow script drives.
 *
 * Neither gates on the agent-spawn semaphore. That gate lives inside `agent()` itself: if a work
 * item held a permit while its nested `agent()` calls queued for one, a `parallel` inside a
 * `pipeline` stage would deadlock — which is the spec's single most common shape.
 */

function assertWithinLimit(count: number, caller: "parallel" | "pipeline"): void {
  if (count > MAX_ITEMS_PER_CALL) {
    fail({
      kind: "LimitError",
      message: `${caller}() received ${count} items; the limit is ${MAX_ITEMS_PER_CALL}.`,
      suggestions: ["Chunk the work and run the chunks in sequence, or narrow the input list."],
    })
  }
}

/**
 * Runs thunks concurrently and waits for all of them. This is a BARRIER.
 *
 * Takes thunks (`() => Promise`), not promises — that is what lets the scheduler hold work back
 * until a slot frees. A thunk that throws resolves to `null` in the result array; the call itself
 * never rejects, so callers must `.filter(Boolean)`.
 */
export async function parallel(thunks: ReadonlyArray<() => unknown>): Promise<unknown[]> {
  if (!Array.isArray(thunks)) {
    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)")
  }
  assertWithinLimit(thunks.length, "parallel")

  // One frame for the whole call, so every thunk shares it and a sibling parallel() gets its own.
  const frame = openFrame("P")

  return await Promise.all(
    thunks.map(async (thunk, index) => {
      // The try must wrap the SYNCHRONOUS invocation too: a thunk that throws before returning a
      // promise (`() => { throw x }`, or a non-function entry) must still resolve to null rather
      // than rejecting the whole barrier.
      try {
        if (typeof thunk !== "function") {
          throw new TypeError(
            "parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)",
          )
        }
        // Each thunk gets its own resume scope: thunks past the concurrency cap start in
        // completion order, so a shared sequence would disagree between runs.
        return await withChildScope("P", frame, index, async () => await thunk())
      } catch (error) {
        // Engine faults must NEVER degrade to null. A LimitError or a determinism trap swallowed
        // here would read as "this agent returned nothing" — the silent truncation the spec
        // explicitly forbids. Only agent/user failures become null.
        if (error instanceof WorkflowScriptError) throw error
        return null
      }
    }),
  )
}

/**
 * Runs each item through every stage independently, with NO barrier between stages.
 *
 * Item A can be in stage 3 while item B is still in stage 1, so wall-clock is the slowest single
 * item chain rather than the sum of per-stage maxima. Stage callbacks receive
 * `(prevResult, originalItem, index)`.
 *
 * An item drops to `null` and skips its remaining stages when a stage throws OR when a stage
 * RETURNS null. The null-return case is the one that is easy to miss and matters most: `agent()`
 * returns null on skip or terminal failure, so without it every ported script would crash on
 * `null.findings` at the next stage.
 *
 * `undefined` is treated the same as `null` — a stage with no explicit return would otherwise
 * crash the next stage on property access, and `null` is the sentinel the spec tells scripts to
 * filter on.
 */
export async function pipeline(
  items: readonly unknown[],
  ...stages: ReadonlyArray<(prev: unknown, item: unknown, index: number) => unknown>
): Promise<unknown[]> {
  if (!Array.isArray(items)) {
    throw new TypeError("pipeline() expects an array of items as its first argument.")
  }
  assertWithinLimit(items.length, "pipeline")

  const frame = openFrame("L")

  return await Promise.all(
    items.map((item, index) =>
      // One scope PER ITEM, spanning all of its stages. That is what makes resume work here:
      // stages within an item are genuinely sequential, while stage-N calls across items fire in
      // model-latency order and must not share a sequence.
      withChildScope("L", frame, index, async () => {
        let current: unknown = item
        for (const stage of stages) {
          try {
            current = await stage(current, item, index)
          } catch (error) {
            // Same rule as parallel(): an engine fault propagates and fails the run loudly, rather
            // than masquerading as a single item that produced no result.
            if (error instanceof WorkflowScriptError) throw error
            return null
          }
          if (current === null || current === undefined) return null
        }
        return current
      }),
    ),
  )
}
