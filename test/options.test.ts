import { describe, expect, test } from "bun:test"
import { resolveOptions } from "../src/server/options.js"
import { LARGE_WORKFLOW_AGENTS, MAX_CONCURRENCY, MIN_CONCURRENCY } from "../src/server/script/limits.js"

const DEFAULT_CONCURRENCY = 8,
  DEFAULT_ULTRACODE_MAX_RUNS = 8,
  DEFAULT_AGENT_DEADLINE_MS = 4 * 60 * 60 * 1000,
  DEFAULT_AGENT_IDLE_MS = 5 * 60 * 1000,
  DEFAULT_EFFORT_PREFERENCE = ["xhigh", "max", "high", "medium", "low"],

 DEFAULTS = {
  concurrency: DEFAULT_CONCURRENCY,
  ultracode: false,
  ultracodeMaxRuns: DEFAULT_ULTRACODE_MAX_RUNS,
  agentDeadlineMs: DEFAULT_AGENT_DEADLINE_MS,
  agentIdleMs: DEFAULT_AGENT_IDLE_MS,
  effortPreference: DEFAULT_EFFORT_PREFERENCE,
  runMode: "background" as const,
  keywordBehavior: "one-shot" as const,
  workflowPaths: [] as string[],
  budgetTokens: null as number | null,
  largeWorkflowAgents: LARGE_WORKFLOW_AGENTS,
  sizeGuideline: undefined as string | undefined,
  autoResume: true,
  autoResumeTtlHours: 24,
  autoResumeMax: 1,
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

describe("resolveOptions — ultracodeMaxRuns", () => {
  test("defaults to 8", () => {
    expect(resolveOptions({}).ultracodeMaxRuns).toBe(DEFAULT_ULTRACODE_MAX_RUNS)
  })

  test.each([
    // 0 is rejected, never honoured: a cap below 1 would refuse every launch
    // forever — a hang with no throw, exactly the concurrency-0 failure shape.
    [0, MIN_CONCURRENCY],
    [-5, MIN_CONCURRENCY],
    [1, 1],
    [MAX_CONCURRENCY + 100, MAX_CONCURRENCY],
    // A float is floored, not rounded or rejected.
    [3.7, 3],
  ])("clamps %p to %p", (input, expected) => {
    expect(resolveOptions({ ultracodeMaxRuns: input }).ultracodeMaxRuns).toBe(expected)
  })

  // Wrapped one-element rows for the same reason as the concurrency cases: some
  // of these inputs are themselves arrays and would be spread onto the callback.
  const nonNumericMaxRuns: unknown[][] = [["8"], [true], [{}], [[]], [Number.NaN], [Number.POSITIVE_INFINITY]]

  test.each(nonNumericMaxRuns)("falls back to the default 8 for %p", (input) => {
    expect(resolveOptions({ ultracodeMaxRuns: input }).ultracodeMaxRuns).toBe(DEFAULT_ULTRACODE_MAX_RUNS)
  })
})

describe("resolveOptions — agentDeadlineMs", () => {
  test("honours a positive number", () => {
    expect(resolveOptions({ agentDeadlineMs: 5000 }).agentDeadlineMs).toBe(5000)
  })

  // 0 is a MEANINGFUL value for the wall clock: it disables the bound, so the idle limit stands
  // alone. Only negatives and non-numbers fall back to the default.
  test("honours 0 as disabled", () => {
    expect(resolveOptions({ agentDeadlineMs: 0 }).agentDeadlineMs).toBe(0)
  })

  const invalidDeadlines: unknown[] = [-1, Number.NaN, Number.POSITIVE_INFINITY, "5000", true, null, {}]

  test.each(invalidDeadlines)("falls back to the default for %p", (input) => {
    expect(resolveOptions({ agentDeadlineMs: input }).agentDeadlineMs).toBe(DEFAULT_AGENT_DEADLINE_MS)
  })
})

describe("resolveOptions — agentIdleMs", () => {
  test("honours a positive number", () => {
    expect(resolveOptions({ agentIdleMs: 1000 }).agentIdleMs).toBe(1000)
  })

  // 0 is NOT honoured for the idle bound: an inactivity limit of zero would kill every agent the
  // instant no progress was observed in a poll tick, which is a hang shaped like a guard.
  const invalidIdle: unknown[] = [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000", true, null, {}]

  test.each(invalidIdle)("falls back to the default for %p", (input) => {
    expect(resolveOptions({ agentIdleMs: input }).agentIdleMs).toBe(DEFAULT_AGENT_IDLE_MS)
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
    first.agentIdleMs = 1

    expect(second.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(second.ultracode).toBe(false)
    expect(second.agentDeadlineMs).toBe(DEFAULT_AGENT_DEADLINE_MS)
    expect(second.agentIdleMs).toBe(DEFAULT_AGENT_IDLE_MS)
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


describe("resolveOptions — runMode", () => {
  test("defaults to background", () => {
    expect(resolveOptions({}).runMode).toBe("background")
  })

  test("an explicit blocking option wins over the default", () => {
    expect(resolveOptions({ runMode: "blocking" }).runMode).toBe("blocking")
  })

  test("option values are normalized, so near-misses still take effect", () => {
    expect(resolveOptions({ runMode: "Blocking" }).runMode).toBe("blocking")
    expect(resolveOptions({ runMode: " background " }).runMode).toBe("background")
  })

  test("an unrecognized value falls back to the default, never throws", () => {
    // resolveOptions' charter: bad values surface NOW as a documented default,
    // not as a throw that breaks config loading.
    expect(resolveOptions({ runMode: "sync" }).runMode).toBe("background")
  })

  test("ULTRAOPEN_WORKFLOW_SYNC=1 forces blocking OVER an explicit option", () => {
    // The env var is the kill switch: a stale config value must not be able to
    // hold the process open against it.
    process.env["ULTRAOPEN_WORKFLOW_SYNC"] = "1"
    try {
      expect(resolveOptions({ runMode: "background" }).runMode).toBe("blocking")
      expect(resolveOptions({ runMode: "bogus" }).runMode).toBe("blocking")
      expect(resolveOptions(undefined).runMode).toBe("blocking")
    } finally {
      delete process.env["ULTRAOPEN_WORKFLOW_SYNC"]
    }
  })

  test("the env var absent, an explicit background option stays background", () => {
    expect(resolveOptions({ runMode: "background" }).runMode).toBe("background")
  })
})

describe("resolveOptions — budgetTokens", () => {
  test("unset means no ceiling (today's behavior)", () => {
    expect(resolveOptions({}).budgetTokens).toBeNull()
    expect(resolveOptions({ budgetTokens: undefined }).budgetTokens).toBeNull()
  })

  test("a positive number is honoured and floored", () => {
    expect(resolveOptions({ budgetTokens: 100_000 }).budgetTokens).toBe(100_000)
    expect(resolveOptions({ budgetTokens: 100.9 }).budgetTokens).toBe(100)
  })

  test("an invalid value means NO ceiling, never a surprise cap", () => {
    // A mistyped ceiling must not trade an uncapped run for a surprise limit.
    for (const bad of [0, -5, "100000", Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(resolveOptions({ budgetTokens: bad as unknown }).budgetTokens).toBeNull()
    }
  })
})

describe("resolveOptions — largeWorkflowAgents", () => {
  test("defaults to the 25-agent launch advisory threshold", () => {
    expect(resolveOptions({}).largeWorkflowAgents).toBe(LARGE_WORKFLOW_AGENTS)
    expect(resolveOptions({ largeWorkflowAgents: undefined }).largeWorkflowAgents).toBe(LARGE_WORKFLOW_AGENTS)
  })

  test("a positive number is honoured and floored", () => {
    expect(resolveOptions({ largeWorkflowAgents: 50 }).largeWorkflowAgents).toBe(50)
    expect(resolveOptions({ largeWorkflowAgents: 10.9 }).largeWorkflowAgents).toBe(10)
  })

  test("an invalid value falls back to the default, never disables the advisory", () => {
    // A mistyped threshold must not silently turn the large-workflow warning off.
    for (const bad of [0, -1, "25", Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(resolveOptions({ largeWorkflowAgents: bad as unknown }).largeWorkflowAgents).toBe(LARGE_WORKFLOW_AGENTS)
    }
  })
})

describe("resolveOptions — sizeGuideline", () => {
  test("unset omits the advice", () => {
    expect(resolveOptions({}).sizeGuideline).toBeUndefined()
  })

  test("a non-empty string is honoured; blanks are omitted", () => {
    expect(resolveOptions({ sizeGuideline: "keep runs under 10 agents" }).sizeGuideline).toBe("keep runs under 10 agents")
    expect(resolveOptions({ sizeGuideline: "   " }).sizeGuideline).toBeUndefined()
    expect(resolveOptions({ sizeGuideline: 42 as unknown }).sizeGuideline).toBeUndefined()
  })
})

describe("resolveOptions — autoResume", () => {
  test("on by default; explicitly false opts out", () => {
    expect(resolveOptions({}).autoResume).toBe(true)
    expect(resolveOptions({ autoResume: undefined }).autoResume).toBe(true)
    expect(resolveOptions({ autoResume: false }).autoResume).toBe(false)
  })

  test("only an explicit false opts out; anything else is not a kill switch", () => {
    // A mistyped value must not silently disable durability.
    for (const value of [0, "", "false", null]) {
      expect(resolveOptions({ autoResume: value as unknown }).autoResume).toBe(true)
    }
  })
})

describe("resolveOptions — autoResumeTtlHours", () => {
  test("defaults to 24 hours", () => {
    expect(resolveOptions({}).autoResumeTtlHours).toBe(24)
    expect(resolveOptions({ autoResumeTtlHours: undefined }).autoResumeTtlHours).toBe(24)
  })

  test("a positive number is honoured, floored, and clamped to a year", () => {
    expect(resolveOptions({ autoResumeTtlHours: 72 }).autoResumeTtlHours).toBe(72)
    expect(resolveOptions({ autoResumeTtlHours: 7.9 }).autoResumeTtlHours).toBe(7)
    expect(resolveOptions({ autoResumeTtlHours: 24 * 365 * 100 }).autoResumeTtlHours).toBe(24 * 365)
  })

  test("an invalid value falls back to the default, never disables resume", () => {
    for (const bad of [0, -1, "24", Number.NaN, Number.POSITIVE_INFINITY, true]) {
      expect(resolveOptions({ autoResumeTtlHours: bad as unknown }).autoResumeTtlHours).toBe(24)
    }
  })
})

describe("resolveOptions — autoResumeMax", () => {
  test("defaults to one adoption per boot", () => {
    expect(resolveOptions({}).autoResumeMax).toBe(1)
    expect(resolveOptions({ autoResumeMax: undefined }).autoResumeMax).toBe(1)
  })

  test("a positive number is honoured, floored, clamped to [1, 64]", () => {
    expect(resolveOptions({ autoResumeMax: 5 }).autoResumeMax).toBe(5)
    expect(resolveOptions({ autoResumeMax: 2.9 }).autoResumeMax).toBe(2)
    expect(resolveOptions({ autoResumeMax: 0 }).autoResumeMax).toBe(1)
    expect(resolveOptions({ autoResumeMax: 1000 }).autoResumeMax).toBe(64)
  })

  test("an invalid value falls back to 1", () => {
    for (const bad of [-4, "1", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveOptions({ autoResumeMax: bad as unknown }).autoResumeMax).toBe(1)
    }
  })
})
