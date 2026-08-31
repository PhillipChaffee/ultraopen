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

  test("reports when only stronger levels exist", () => {
    const onlyMax = { available: ["max"], modelLabel: "odd" }
    const result = resolveEffort("low", onlyMax)
    expect(result.variant).toBeUndefined()
    expect(result.note).toContain("no weaker level")
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
