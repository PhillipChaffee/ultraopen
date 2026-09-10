import { describe, expect, test } from "bun:test"
import { resolveOptions } from "../src/server/options.js"
import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "../src/server/script/limits.js"

const DEFAULT_CONCURRENCY = 8,
 DEFAULT_AGENT_DEADLINE_MS = 15 * 60 * 1000,
 DEFAULT_EFFORT_PREFERENCE = ["xhigh", "max", "high", "medium", "low"],

 DEFAULTS = {
  concurrency: DEFAULT_CONCURRENCY,
  ultracode: false,
  agentDeadlineMs: DEFAULT_AGENT_DEADLINE_MS,
  effortPreference: DEFAULT_EFFORT_PREFERENCE,
}

describe("resolveOptions — non-object input", () => {
  test.each([undefined, null, "not an object", 42])("falls back to defaults for %p", (raw) => {
    expect(resolveOptions(raw)).toEqual(DEFAULTS)
  })
})

describe("resolveOptions — empty object", () => {
  test("falls back to defaults", () => {
    expect(resolveOptions({})).toEqual(DEFAULTS)
  })
})

describe("resolveOptions — concurrency", () => {
  test.each([
    // `0 ?? 8` is `0`, and a limit below 1 makes every acquire wait forever — a hang with no throw.
    // 0 must clamp to MIN, never pass through as-is.
    [0, MIN_CONCURRENCY],
    [-5, MIN_CONCURRENCY],
    [1, 1],
    [MAX_CONCURRENCY + 100, MAX_CONCURRENCY],
    // A float is floored, not rounded or rejected.
    [3.7, 3],
  ])("clamps %p to %p", (input, expected) => {
    expect(resolveOptions({ concurrency: input }).concurrency).toBe(expected)
  })

  // Each case is wrapped in its own one-element row: `test.each` spreads a row's entries onto the
  // callback's parameters, and an unwrapped array item (like `[]`) would itself be spread apart —
  // wrapping keeps every case a single opaque argument regardless of its own shape.
  const nonNumericConcurrency: unknown[][] = [["8"], [true], [{}], [[]], [Number.NaN], [Number.POSITIVE_INFINITY]]

  test.each(nonNumericConcurrency)("falls back to the default 8 for %p", (input) => {
    expect(resolveOptions({ concurrency: input }).concurrency).toBe(DEFAULT_CONCURRENCY)
  })
})

describe("resolveOptions — ultracode", () => {
  test.each([
    [{ ultracode: true }, true],
    [{ mode: "ultracode" }, true],
    [{ ultracode: true, mode: "other" }, true],
  ])("resolves true for %p", (input, expected) => {
    expect(resolveOptions(input).ultracode).toBe(expected)
  })

  test.each([
    [{}, false],
    // A string "true" is not the boolean true — only a strict boolean opts in.
    [{ ultracode: "true" }, false],
    [{ mode: "other" }, false],
    [{ ultracode: false }, false],
  ])("resolves false for %p", (input, expected) => {
    expect(resolveOptions(input).ultracode).toBe(expected)
  })
})

describe("resolveOptions — agentDeadlineMs", () => {
  test("honours a positive number", () => {
    expect(resolveOptions({ agentDeadlineMs: 5000 }).agentDeadlineMs).toBe(5000)
  })

  const invalidDeadlines: unknown[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000", true, null, {}]

  test.each(invalidDeadlines)("falls back to the default for %p", (input) => {
    expect(resolveOptions({ agentDeadlineMs: input }).agentDeadlineMs).toBe(DEFAULT_AGENT_DEADLINE_MS)
  })
})

describe("resolveOptions — effortPreference", () => {
  test("honours a valid string array", () => {
    expect(resolveOptions({ effortPreference: ["low", "medium"] }).effortPreference).toEqual(["low", "medium"])
  })

  // Wrapped one-element rows for the same reason as the concurrency cases above: several of these
  // inputs are themselves arrays, and an unwrapped array row would be spread onto the callback.
  const invalidEffortPreference: unknown[][] = [
    ["not an array"],
    [42],
    [{}],
    // An empty array has nothing usable, same as omitting the field.
    [[]],
    // Only non-strings — none survive the filter.
    [[1, 2, 3]],
    // Only blanks — each is a string, but trimmed to nothing.
    [["", "   "]],
  ]

  test.each(invalidEffortPreference)("falls back to the default for %p", (input) => {
    expect(resolveOptions({ effortPreference: input }).effortPreference).toEqual(DEFAULT_EFFORT_PREFERENCE)
  })

  test("keeps only the strings when the array mixes strings and non-strings", () => {
    const result = resolveOptions({ effortPreference: ["high", 1, "low", null, "", "medium"] })
    expect(result.effortPreference).toEqual(["high", "low", "medium"])
  })
})

describe("resolveOptions — returns a fresh copy", () => {
  test("mutating a primitive field on one result does not affect a later call", () => {
    const first = resolveOptions({}),
     second = resolveOptions({})
    expect(first).not.toBe(second)

    first.concurrency = 999
    first.ultracode = true
    first.agentDeadlineMs = 1

    expect(second.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(second.ultracode).toBe(false)
    expect(second.agentDeadlineMs).toBe(DEFAULT_AGENT_DEADLINE_MS)
  })

  test("mutating one result's user-supplied effortPreference array does not affect a later call", () => {
    const first = resolveOptions({ effortPreference: ["high", "low"] }),
     second = resolveOptions({ effortPreference: ["high", "low"] }),

    // `stringArray` always runs the input through `.filter()`, which allocates a new array even
    // when every entry survives — so two calls with equal-looking input never share a backing array.
     mutableEffort = first.effortPreference as string[]
    mutableEffort.push("mutated")

    expect(second.effortPreference).toEqual(["high", "low"])
  })

  // KNOWN SOURCE BUG (reported, not fixed — see task report): unlike the user-supplied-array path
  // above, the DEFAULT `effortPreference` is never copied. `stringArray(...) ?? DEFAULTS.effortPreference`
  // hands back the literal module-level `DEFAULTS.effortPreference` array on every call that falls
  // through to it, so two calls that both take the default share the exact same array instance —
  // and mutating it (e.g. via an unsafe `as string[]` cast past the `readonly` type) would corrupt
  // every future call's defaults, including `DEFAULTS` itself, for the process's lifetime.
  test("the default effortPreference array is shared by reference across calls, not copied", () => {
    const first = resolveOptions({}),
     second = resolveOptions({})
    expect(first.effortPreference).toBe(second.effortPreference)
  })
})
