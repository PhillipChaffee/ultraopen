import { describe, expect, test } from "bun:test"
import { makeEffortResolver, resolveEffort } from "../src/server/bridge/effort.js"

/** Real variant sets, taken from what opencode reports for these model families. */
const CLAUDE_5 = { available: ["low", "medium", "high", "xhigh", "max"], modelLabel: "claude-opus-5" }
const CLAUDE_46 = { available: ["low", "medium", "high", "max"], modelLabel: "claude-sonnet-4-6" }
const NO_VARIANTS = { available: [], modelLabel: "kimi-k2.6" }

describe("resolveEffort", () => {
  test("passes through a supported variant unchanged", () => {
    const result = resolveEffort("xhigh", CLAUDE_5)
    expect(result.variant).toBe("xhigh")
    expect(result.note).toBeUndefined()
  })

  test("returns no variant when none was requested", () => {
    expect(resolveEffort(undefined, CLAUDE_5).variant).toBeUndefined()
    expect(resolveEffort("", CLAUDE_5).variant).toBeUndefined()
  })

  test('"default" is opencode\'s own sentinel for no variant', () => {
    expect(resolveEffort("default", CLAUDE_5).variant).toBeUndefined()
  })

  test("downgrades xhigh to high on a model that lacks it, and says so", () => {
    // The silent-failure this exists for: opencode resolves an unknown variant to undefined,
    // merges it as {}, and reports nothing — so ultracode would quietly do no extra thinking.
    const result = resolveEffort("xhigh", CLAUDE_46)
    expect(result.variant).toBe("high")
    expect(result.downgradedFrom).toBe("xhigh")
    expect(result.note).toContain("claude-sonnet-4-6")
    expect(result.note).toContain("high")
  })

  test("never escalates past what was asked for", () => {
    // CLAUDE_46 has "max", which is STRONGER than the requested "xhigh". Silently spending more
    // than requested would be its own surprise, so the fallback only ever goes downward.
    expect(resolveEffort("xhigh", CLAUDE_46).variant).toBe("high")
  })

  test("falls back further when intermediate levels are also missing", () => {
    const sparse = { available: ["low"], modelLabel: "sparse" }
    expect(resolveEffort("xhigh", sparse).variant).toBe("low")
  })

  test("reports when a model has no reasoning variants at all", () => {
    const result = resolveEffort("xhigh", NO_VARIANTS)
    expect(result.variant).toBeUndefined()
    expect(result.note).toContain("no reasoning variants")
  })

  test("an unknown effort level sends no variant rather than guessing", () => {
    const result = resolveEffort("turbo", CLAUDE_5)
    expect(result.variant).toBeUndefined()
    expect(result.note).toContain("not a known level")
    expect(result.note).toContain("low, medium, high, xhigh, max")
  })

  test("does not escalate a LOW request several rungs up to an expensive level", () => {
    // A model offering only ["max"] cannot honour "low". Jumping to max would be a large, silent
    // cost increase in the opposite direction from what was asked, so send nothing instead.
    const onlyMax = { available: ["max"], modelLabel: "odd" }
    const result = resolveEffort("low", onlyMax)
    expect(result.variant).toBeUndefined()
    expect(result.note).toContain("offers only max")
  })

  test("ignores blank entries in the available list", () => {
    expect(resolveEffort("high", { available: ["", "high"] }).variant).toBe("high")
  })

  test('falls back to "this model" when no label is supplied', () => {
    expect(resolveEffort("xhigh", { available: [] }).note).toContain("this model")
  })
})

describe("makeEffortResolver", () => {
  test("resolves and reports downgrades to the run log", () => {
    const notes: string[] = []
    const resolve = makeEffortResolver(CLAUDE_46, (note) => notes.push(note))

    expect(resolve("xhigh")).toBe("high")
    expect(notes.length).toBe(1)
    expect(notes[0]).toContain("unsupported")
  })

  test("stays quiet when the request is honoured exactly", () => {
    const notes: string[] = []
    const resolve = makeEffortResolver(CLAUDE_5, (note) => notes.push(note))

    expect(resolve("xhigh")).toBe("xhigh")
    expect(notes).toEqual([])
  })

  test("works without a downgrade callback", () => {
    expect(makeEffortResolver(CLAUDE_46)("xhigh")).toBe("high")
  })
})

/**
 * Every distinct variant set the live opencode catalog reports (13 of them, surveyed across all
 * 64 models). The original ladder assumed an Anthropic-shaped ["low"…"max"] and missed both
 * "minimal" and "none" entirely.
 */
const REAL_SETS = {
  gpt5: ["none", "minimal", "low", "medium", "high", "xhigh"],
  gpt51: ["none", "low", "medium", "high"],
  gpt5Pro: ["medium", "high", "xhigh"],
  claude5: ["low", "medium", "high", "xhigh", "max"],
  claude46: ["low", "medium", "high", "max"],
  sonnet4: ["high", "max"],
  gemini: ["low", "medium", "high"],
  geminiFlash: ["none", "minimal", "low", "medium", "high"],
  kimiK3: ["max"],
  deepseekFlash: ["low", "high", "max"],
  none: [],
} as const

describe("real-world variant sets", () => {
  test.each([
    ["gpt5", "xhigh", "xhigh"],
    ["gpt51", "xhigh", "high"],
    ["gpt5Pro", "xhigh", "xhigh"],
    ["gpt5Pro", "low", "medium"],
    ["claude5", "xhigh", "xhigh"],
    ["claude46", "xhigh", "high"],
    ["sonnet4", "xhigh", "high"],
    ["gemini", "xhigh", "high"],
    ["geminiFlash", "xhigh", "high"],
    ["kimiK3", "xhigh", "max"],
    ["deepseekFlash", "xhigh", "high"],
  ])("%s asked for %s resolves to %s", (setName, requested, expected) => {
    const available = REAL_SETS[setName as keyof typeof REAL_SETS]
    expect(resolveEffort(requested, { available, modelLabel: setName }).variant).toBe(expected)
  })

  test("a model offering ONLY a stronger level escalates rather than sending nothing", () => {
    // kimi-k3 exposes just ["max"]. Refusing would leave an ultracode run with no reasoning at
    // all, which is further from the request than overshooting it.
    const result = resolveEffort("xhigh", { available: REAL_SETS.kimiK3, modelLabel: "kimi-k3" })
    expect(result.variant).toBe("max")
    expect(result.note).toContain("nearest level")
  })

  test('a downgrade never lands on "none"', () => {
    // "none" is an explicit off switch, not a weaker setting. Someone asking for high has not
    // asked for reasoning to be disabled — so this takes the one-rung escalation instead.
    expect(resolveEffort("high", { available: ["none", "xhigh"], modelLabel: "odd" }).variant).toBe("xhigh")
    // And two rungs up is too far, so nothing is sent.
    expect(resolveEffort("medium", { available: ["none", "xhigh"], modelLabel: "odd" }).variant).toBeUndefined()
  })

  test('"none" is still honoured when explicitly requested', () => {
    expect(resolveEffort("none", { available: REAL_SETS.gpt5 }).variant).toBe("none")
  })

  test('"minimal" ranks below "low"', () => {
    // opencode builds its arrays ascending and unshifts "minimal" ahead of low/medium/high.
    expect(resolveEffort("low", { available: ["none", "minimal"] }).variant).toBe("minimal")
  })

  test("every real set resolves an xhigh request to SOMETHING when it has any usable level", () => {
    for (const [name, available] of Object.entries(REAL_SETS)) {
      const usable = available.filter((entry) => entry !== "none")
      const result = resolveEffort("xhigh", { available, modelLabel: name })
      if (usable.length === 0) expect(result.variant).toBeUndefined()
      else expect(result.variant).toBeDefined()
    }
  })

  test("a supported request is never rewritten", () => {
    for (const [name, available] of Object.entries(REAL_SETS)) {
      for (const level of available) {
        expect(resolveEffort(level, { available, modelLabel: name }).variant).toBe(level)
      }
    }
  })
})
