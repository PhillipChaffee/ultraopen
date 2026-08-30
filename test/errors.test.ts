import { describe, expect, test } from "bun:test"
import { fail, render, WorkflowScriptError, type Diagnostic } from "../src/server/script/errors.js"

describe("WorkflowScriptError", () => {
  test("carries its diagnostic and a conventional name", () => {
    const diagnostic: Diagnostic = { kind: "MetaError", message: "boom" }
    const err = new WorkflowScriptError(diagnostic)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("WorkflowScriptError")
    expect(err.message).toBe("boom")
    expect(err.diagnostic).toBe(diagnostic)
  })

  test("fail() throws it", () => {
    expect(() => fail({ kind: "LimitError", message: "too big" })).toThrow(WorkflowScriptError)
  })
})

describe("render", () => {
  const source = ["const a = 1", "const b = 2", "const c = 3"].join("\n")

  test("renders a caret line under the offending column when source is supplied", () => {
    const out = render({ kind: "MetaError", message: "bad", location: { line: 2, column: 6 } }, source)
    const lines = out.split("\n")
    expect(lines[0]).toBe("MetaError: bad")
    expect(lines[2]).toBe("2 | const b = 2")
    // The caret sits under column 6 of the source, offset by the gutter width.
    expect(lines[3]).toBe(`${" ".repeat("2 | ".length + 6)}^`)
  })

  test("falls back to a line:col note when no source is supplied", () => {
    const out = render({ kind: "ParseError", message: "bad", location: { line: 7, column: 3 } })
    expect(out).toContain("at line 7:3")
    expect(out).not.toContain("^")
  })

  test("omits the caret when the location points past the end of the source", () => {
    const out = render({ kind: "ParseError", message: "bad", location: { line: 99, column: 0 } }, source)
    expect(out).toBe("ParseError: bad")
  })

  test("clamps a negative column rather than throwing", () => {
    const out = render({ kind: "ParseError", message: "bad", location: { line: 1, column: -5 } }, source)
    expect(out).toContain("^")
  })

  test("appends suggestions with an arrow prefix", () => {
    const out = render({ kind: "DeterminismError", message: "nope", suggestions: ["do this", "or that"] })
    expect(out).toContain("  → do this")
    expect(out).toContain("  → or that")
  })

  test("renders bare message when there is no location and no suggestions", () => {
    expect(render({ kind: "RuntimeError", message: "plain" })).toBe("RuntimeError: plain")
  })

  test("ignores an empty suggestions array", () => {
    expect(render({ kind: "RuntimeError", message: "plain", suggestions: [] })).toBe("RuntimeError: plain")
  })
})
