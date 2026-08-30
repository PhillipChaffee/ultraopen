import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * Guards the coverage gate itself.
 *
 * On Bun 1.4.0 the object forms of `coverageThreshold` parse without complaint and then silently
 * do not enforce — a run at 84% coverage exits 0 against a 0.99 bar. Only the scalar form works.
 * If someone "tidies" this into the more readable per-metric object, coverage would stop being
 * enforced with no visible signal, so assert the shape here.
 */
describe("coverage gate", () => {
  const raw = readFileSync(new URL("../bunfig.toml", import.meta.url), "utf8")
  // Strip comments — the file documents the broken forms, so a naive scan would match its own docs.
  const bunfig = raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")

  test("coverageThreshold uses the scalar form, which is the only one Bun enforces", () => {
    const match = bunfig.match(/^coverageThreshold\s*=\s*([\d.]+)\s*$/mu)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(0.95)
  })

  test("no object-form coverageThreshold is present", () => {
    expect(bunfig).not.toContain("[test.coverageThreshold]")
    expect(bunfig).not.toMatch(/coverageThreshold\s*=\s*\{/u)
  })

  test("coverage is enabled by default so the gate runs on a bare `bun test`", () => {
    expect(bunfig).toMatch(/^coverage\s*=\s*true$/mu)
  })
})
