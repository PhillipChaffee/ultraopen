import { describe, expect, test } from "bun:test"
import { validate } from "../src/server/bridge/validate.js"

const ok = (value: unknown, schema: Record<string, unknown>) => validate(value, schema).valid
const errorsOf = (value: unknown, schema: Record<string, unknown>): string[] => {
  const result = validate(value, schema)
  return result.valid ? [] : result.errors
}

describe("type checking", () => {
  test.each([
    ["string", "hi", true],
    ["string", 1, false],
    ["number", 1.5, true],
    ["number", "1", false],
    ["number", Number.POSITIVE_INFINITY, false],
    ["integer", 3, true],
    ["integer", 3.5, false],
    ["boolean", false, true],
    ["boolean", 0, false],
    ["null", null, true],
    ["null", 0, false],
    ["array", [], true],
    ["array", {}, false],
    ["object", {}, true],
    ["object", [], false],
    ["object", null, false],
  ])("type %s accepts %p -> %p", (type, value, expected) => {
    expect(ok(value, { type })).toBe(expected)
  })

  test("a union of types is satisfied by any member", () => {
    expect(ok("hi", { type: ["string", "null"] })).toBe(true)
    expect(ok(null, { type: ["string", "null"] })).toBe(true)
    expect(ok(1, { type: ["string", "null"] })).toBe(false)
  })

  test("an unrecognised type keyword is treated as satisfied", () => {
    // A validator that rejects valid data would be worse than one that misses an edge.
    expect(ok("anything", { type: "date-time" })).toBe(true)
  })

  test("a mismatched type reports what it actually got", () => {
    expect(errorsOf([], { type: "object" })[0]).toContain("array")
    expect(errorsOf(null, { type: "object" })[0]).toContain("null")
  })
})

describe("objects", () => {
  const schema = {
    type: "object",
    required: ["name", "count"],
    properties: { name: { type: "string" }, count: { type: "number" }, note: { type: "string" } },
  }

  test("accepts a valid object with optional fields omitted", () => {
    expect(ok({ name: "a", count: 1 }, schema)).toBe(true)
  })

  test("reports every missing required property", () => {
    const errors = errorsOf({}, schema)
    expect(errors.some((e) => e.includes('"name"'))).toBe(true)
    expect(errors.some((e) => e.includes('"count"'))).toBe(true)
  })

  test("checks nested property types and names the path", () => {
    expect(errorsOf({ name: 1, count: 1 }, schema)[0]).toContain("name")
  })

  test("additionalProperties:false rejects extras", () => {
    const strict = { ...schema, additionalProperties: false }
    expect(errorsOf({ name: "a", count: 1, extra: true }, strict)[0]).toContain('"extra"')
  })

  test("additionalProperties defaults to permissive", () => {
    expect(ok({ name: "a", count: 1, extra: true }, schema)).toBe(true)
  })

  test("nested objects report a dotted path", () => {
    const nested = {
      type: "object",
      properties: { inner: { type: "object", properties: { deep: { type: "string" } } } },
    }
    expect(errorsOf({ inner: { deep: 1 } }, nested)[0]).toContain("inner.deep")
  })

  test("a non-array `required` is ignored rather than throwing", () => {
    expect(ok({}, { type: "object", required: "name" })).toBe(true)
  })
})

describe("arrays", () => {
  const schema = { type: "array", items: { type: "string" } }

  test("accepts a matching array and reports the offending index", () => {
    expect(ok(["a", "b"], schema)).toBe(true)
    expect(errorsOf(["a", 2], schema)[0]).toContain("[1]")
  })

  test("minItems is enforced", () => {
    expect(errorsOf([], { type: "array", minItems: 1 })[0]).toContain("at least 1")
  })

  test("an array with no items schema accepts anything", () => {
    expect(ok([1, "a", null], { type: "array" })).toBe(true)
  })

  test("arrays nested in objects report a combined path", () => {
    const nested = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } }
    expect(errorsOf({ tags: ["ok", 3] }, nested)[0]).toContain("tags[1]")
  })
})

describe("enum", () => {
  test("accepts a listed value and rejects others", () => {
    expect(ok("a", { enum: ["a", "b"] })).toBe(true)
    expect(ok("c", { enum: ["a", "b"] })).toBe(false)
  })

  test("compares structurally, not by reference", () => {
    expect(ok({ a: [1, 2] }, { enum: [{ a: [1, 2] }] })).toBe(true)
    expect(ok({ a: [1, 3] }, { enum: [{ a: [1, 2] }] })).toBe(false)
  })

  test("distinguishes objects with different key counts", () => {
    expect(ok({ a: 1, b: 2 }, { enum: [{ a: 1 }] })).toBe(false)
  })

  test("an enum failure short-circuits the type check", () => {
    expect(errorsOf("c", { type: "string", enum: ["a"] }).length).toBe(1)
  })
})

describe("bounds", () => {
  test("numeric minimum and maximum", () => {
    expect(errorsOf(1, { type: "number", minimum: 5 })[0]).toContain(">= 5")
    expect(errorsOf(9, { type: "number", maximum: 5 })[0]).toContain("<= 5")
    expect(ok(5, { type: "number", minimum: 5, maximum: 5 })).toBe(true)
  })

  test("string minLength", () => {
    expect(errorsOf("", { type: "string", minLength: 1 })[0]).toContain("at least 1")
  })
})

describe("realistic agent output", () => {
  const findings = {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "severity"],
          properties: { title: { type: "string" }, severity: { enum: ["high", "medium", "low"] } },
        },
      },
    },
  }

  test("accepts a well-formed result", () => {
    expect(ok({ findings: [{ title: "a", severity: "high" }] }, findings)).toBe(true)
  })

  test("catches a bad enum deep inside", () => {
    expect(errorsOf({ findings: [{ title: "a", severity: "critical" }] }, findings)[0]).toContain("severity")
  })

  test("catches the compaction case: a string where an object was promised", () => {
    // This is the failure the validator exists for — a stripped `format` returns plain text with
    // no error at all, so nothing upstream would have caught it.
    expect(ok("I found three issues...", findings)).toBe(false)
  })
})
