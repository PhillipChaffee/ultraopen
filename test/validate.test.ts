import { describe, expect, test } from "bun:test"
import { findContradictions, validate } from "../src/server/bridge/validate.js"

const ok = (value: unknown, schema: Record<string, unknown>) => validate(value, schema).valid,
 errorsOf = (value: unknown, schema: Record<string, unknown>): string[] => {
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

describe("schema pre-validation — provable self-contradictions", () => {
  test("a required key ruled out by additionalProperties: false is flagged, naming the key", () => {
    const contradictions = findContradictions({
      type: "object",
      additionalProperties: false,
      required: ["name", "extra"],
      properties: { name: { type: "string" } },
    })
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]).toContain('"extra"')
    expect(contradictions[0]).toContain("additionalProperties")
  })

  test("a required key is still ruled out when properties is absent entirely", () => {
    expect(findContradictions({ type: "object", additionalProperties: false, required: ["id"] })).toHaveLength(1)
  })

  test("minimum above maximum is flagged", () => {
    const contradictions = findContradictions({ type: "number", minimum: 10, maximum: 5 })
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]).toContain("minimum 10")
    expect(contradictions[0]).toContain("maximum 5")
  })

  test("an integer-pinned bound pair is flagged too", () => {
    expect(findContradictions({ type: "integer", minimum: 2, maximum: 1 })).toHaveLength(1)
  })

  test("a type array or a numeric enum that forces the type is honored", () => {
    expect(findContradictions({ type: ["number"], minimum: 10, maximum: 5 })).toHaveLength(1)
    expect(findContradictions({ enum: [1, 2], minimum: 10, maximum: 5 })).toHaveLength(1)
  })

  test("equal bounds are satisfiable (minimum === maximum)", () => {
    expect(findContradictions({ type: "number", minimum: 5, maximum: 5 })).toHaveLength(0)
  })

  test("a contradiction nested in a required property is flagged with its path", () => {
    const contradictions = findContradictions({
      type: "object",
      required: ["count"],
      properties: { count: { type: "number", minimum: 10, maximum: 5 } },
    })
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]).toContain("properties.count")
  })

  test("a contradiction nested in a required property's own required/additionalProperties pair is flagged", () => {
    const contradictions = findContradictions({
      type: "object",
      required: ["meta"],
      properties: { meta: { type: "object", additionalProperties: false, required: ["id"], properties: {} } },
    })
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]).toContain("properties.meta")
    expect(contradictions[0]).toContain('"id"')
  })

  test("a contradiction inside items is flagged when minItems forces a member", () => {
    const contradictions = findContradictions({
      type: "array",
      minItems: 1,
      items: { type: "number", minimum: 10, maximum: 5 },
    })
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]).toContain("items")
  })

  test("a contradiction under items of a required property carries the full path", () => {
    const contradictions = findContradictions({
      type: "object",
      required: ["tags"],
      properties: { tags: { type: "array", minItems: 1, items: { type: "number", minimum: 10, maximum: 5 } } },
    })
    expect(contradictions).toHaveLength(1)
    expect(contradictions[0]).toContain("properties.tags.items")
  })

  test("both contradiction shapes on one schema are reported together", () => {
    const contradictions = findContradictions({
      type: "object",
      additionalProperties: false,
      required: ["ghost", "count"],
      properties: { count: { type: "number", minimum: 10, maximum: 5 } },
    })
    expect(contradictions).toHaveLength(2)
  })

  test.each([
    ["every required key is in properties", { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string" } } }],
    ["no additionalProperties: false to rule a key out", { type: "object", required: ["extra"], properties: { name: { type: "string" } } }],
    ["the contradictory property is optional", { type: "object", properties: { opt: { type: "number", minimum: 10, maximum: 5 } } }],
    ["items can be dodged by an empty array", { type: "array", items: { type: "number", minimum: 10, maximum: 5 } }],
    ["minItems: 0 permits the empty array", { type: "array", minItems: 0, items: { type: "number", minimum: 10, maximum: 5 } }],
    ["bounds are vacuous on a string", { type: "string", minimum: 10, maximum: 5 }],
    ["bounds without a type are escaped by any non-number", { minimum: 10, maximum: 5 }],
    ["the type union lets a string escape", { type: ["object", "string"], additionalProperties: false, required: ["x"] }],
    ["the enum lets a non-object member escape", { enum: ["a"], additionalProperties: false, required: ["x"] }],
    ["patternProperties may admit the required key", { type: "object", additionalProperties: false, required: ["x"], patternProperties: { "^x": {} } }],
    ["$ref changes sibling semantics", { type: "object", additionalProperties: false, required: ["x"], $ref: "#/$defs/thing" }],
    ["unevaluatedProperties changes sibling semantics", { type: "object", additionalProperties: false, required: ["x"], unevaluatedProperties: false }],
    ["additionalProperties: true admits the key", { type: "object", additionalProperties: true, required: ["x"] }],
    ["a non-array required is ignored", { type: "object", additionalProperties: false, required: "x" }],
    ["a non-string required key is ignored", { type: "object", additionalProperties: false, required: [1], properties: {} }],
    ["a non-string required key is never descended into", { type: "object", additionalProperties: false, required: [1], properties: { 1: { type: "number", minimum: 10, maximum: 5 } } }],
    ["items without a pinned array type is escaped by any non-array", { minItems: 1, items: { type: "number", minimum: 10, maximum: 5 } }],
    ["enum forcing is silenced by an unmodelled applicator", { enum: [{}], oneOf: [{ type: "string" }], additionalProperties: false, required: ["id"] }],
    ["a malformed properties silences the node", { type: "object", additionalProperties: false, required: ["x"], properties: [] }],
  ])("satisfiable near-miss: %s", (_name, schema) => {
    expect(findContradictions(schema as Record<string, unknown>)).toEqual([])
  })

  test("pinned-type forcing holds even alongside an unmodelled applicator", () => {
    // The applicator can only restrict further — every instance still has the pinned type.
    expect(
      findContradictions({ type: "object", additionalProperties: false, required: ["id"], properties: {}, oneOf: [{ type: "object" }, { type: "string" }] }),
    ).toHaveLength(1)
  })

  test("a required key matching an inherited prototype name is still flagged", () => {
    // `"toString" in {}` is true via Object.prototype; the walk must ask the schema's own keys.
    expect(findContradictions({ type: "object", additionalProperties: false, required: ["toString"], properties: {} })[0]).toContain('"toString"')
  })

  test("a malformed schema is silenced rather than crashed on", () => {
    expect(findContradictions(null as unknown as Record<string, unknown>)).toEqual([])
    expect(findContradictions(undefined as unknown as Record<string, unknown>)).toEqual([])
    expect(findContradictions([] as unknown as Record<string, unknown>)).toEqual([])
  })

  test("an enum that forces the object type still proves the contradiction", () => {
    expect(findContradictions({ enum: [{}], additionalProperties: false, required: ["x"] })).toHaveLength(1)
  })

  test("a cyclic schema does not hang the walk", () => {
    const node: Record<string, unknown> = { type: "object", required: ["self"], properties: {} }
    node["properties"] = { self: node }
    expect(findContradictions(node)).toHaveLength(0)
  })

  test("a cyclic schema containing a contradiction flags it exactly once", () => {
    // The visited-set short-circuits the second arrival, so the cycle must not double-count.
    const node: Record<string, unknown> = { type: "number", minimum: 10, maximum: 5 }
    node["properties"] = { self: node }
    expect(findContradictions(node)).toHaveLength(1)
  })
})
