import { describe, expect, test } from "bun:test"
import { argsHash, canonicalOptions, chainKey, scopeSeed, sourceHash, stableStringify } from "../src/server/resume/key.js"

describe("stableStringify", () => {
  test("sorts object keys so property order cannot change a hash", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  test("sorts recursively", () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }))
  })

  test("preserves array order, which IS semantic", () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  test("drops undefined values and __proto__", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
    expect(stableStringify(JSON.parse('{"a":1,"__proto__":{"x":1}}'))).toBe(stableStringify({ a: 1 }))
  })

  test.each([[null], [1], ["s"], [true]])("handles the primitive %p", (value) => {
    expect(stableStringify(value)).toBe(JSON.stringify(value))
  })

  test("undefined serialises as null rather than throwing", () => {
    expect(stableStringify(undefined)).toBe("null")
  })
})

describe("canonicalOptions", () => {
  test("EXCLUDES label and phase", () => {
    // Renaming an agent for readability must not invalidate its cached result — that would punish
    // exactly the kind of tidying edit resume is supposed to make cheap.
    expect(canonicalOptions({ label: "a", phase: "Find" })).toBe(canonicalOptions({ label: "b", phase: "Verify" }))
  })

  test("INCLUDES every option that changes the answer", () => {
    const base = canonicalOptions({})
    expect(canonicalOptions({ schema: { type: "object" } })).not.toBe(base)
    expect(canonicalOptions({ model: "a/b" })).not.toBe(base)
    expect(canonicalOptions({ effort: "xhigh" })).not.toBe(base)
    expect(canonicalOptions({ agentType: "explore" })).not.toBe(base)
    expect(canonicalOptions({ isolation: "worktree" })).not.toBe(base)
    expect(canonicalOptions({ disallowedTools: ["bash"] })).not.toBe(base)
  })

  test("is insensitive to schema property order", () => {
    const a = canonicalOptions({ schema: { type: "object", required: ["x"] } })
    const b = canonicalOptions({ schema: { required: ["x"], type: "object" } })
    expect(a).toBe(b)
  })
})

describe("chainKey", () => {
  test("differs when the prompt differs", () => {
    expect(chainKey("k", "a", {})).not.toBe(chainKey("k", "b", {}))
  })

  test("differs when the PREVIOUS key differs — this is what makes an edit cascade", () => {
    // A content-only key would happily replay call four against a changed call three.
    expect(chainKey("k1", "same", {})).not.toBe(chainKey("k2", "same", {}))
  })

  test("is stable for identical inputs", () => {
    expect(chainKey("k", "a", { effort: "xhigh" })).toBe(chainKey("k", "a", { effort: "xhigh" }))
  })

  test("is unaffected by a label change", () => {
    expect(chainKey("k", "a", { label: "one" })).toBe(chainKey("k", "a", { label: "two" }))
  })

  test("carries a version prefix so a future format change is detectable", () => {
    expect(chainKey("k", "a", {}).startsWith("v1:")).toBe(true)
  })
})

describe("scopeSeed", () => {
  test("differs per frame", () => {
    expect(scopeSeed("parent", "L0.0")).not.toBe(scopeSeed("parent", "L0.1"))
  })

  test("depends on the parent chain, so edits BEFORE a combinator invalidate everything inside", () => {
    expect(scopeSeed("parentA", "L0.0")).not.toBe(scopeSeed("parentB", "L0.0"))
  })
})

describe("hashes", () => {
  test("argsHash is order-insensitive but value-sensitive", () => {
    expect(argsHash({ a: 1, b: 2 })).toBe(argsHash({ b: 2, a: 1 }))
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }))
  })

  test("argsHash treats undefined and null alike", () => {
    expect(argsHash(undefined)).toBe(argsHash(null))
  })

  test("sourceHash changes with any edit", () => {
    expect(sourceHash("a")).not.toBe(sourceHash("a "))
  })
})
