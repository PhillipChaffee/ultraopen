import { describe, expect, test } from "bun:test"
import { assertWithinBudget, makeBudget, parseBudgetDirective } from "../src/server/runtime/budget.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"

describe("makeBudget", () => {
  test("with no target, remaining is Infinity", () => {
    // Every documented loop guards on `budget.total` precisely because of this — an unguarded
    // loop would otherwise run to the 1000-agent backstop.
    const budget = makeBudget({ total: null, spent: () => 100 })
    expect(budget.total).toBeNull()
    expect(budget.remaining()).toBe(Number.POSITIVE_INFINITY)
  })

  test("remaining tracks live spend", () => {
    let spent = 0
    const budget = makeBudget({ total: 1000, spent: () => spent })
    expect(budget.remaining()).toBe(1000)
    spent = 400
    expect(budget.remaining()).toBe(600)
  })

  test("remaining never goes negative", () => {
    const budget = makeBudget({ total: 100, spent: () => 250 })
    expect(budget.remaining()).toBe(0)
  })
})

describe("assertWithinBudget", () => {
  test("permits calls below the ceiling", () => {
    expect(() => assertWithinBudget(makeBudget({ total: 100, spent: () => 99 }))).not.toThrow()
  })

  test("throws once spend reaches the ceiling", () => {
    // A HARD ceiling: checked BEFORE the call, since spending past the target and then reporting
    // it would defeat the point.
    expect(() => assertWithinBudget(makeBudget({ total: 100, spent: () => 100 }))).toThrow(WorkflowScriptError)
  })

  test("names the target and the spend so the message is actionable", () => {
    try {
      assertWithinBudget(makeBudget({ total: 500, spent: () => 640 }))
      expect.unreachable()
    } catch (error) {
      expect((error as Error).message).toContain("500")
      expect((error as Error).message).toContain("640")
    }
  })

  test("never throws when no target was set", () => {
    expect(() => assertWithinBudget(makeBudget({ total: null, spent: () => 1e9 }))).not.toThrow()
  })
})

describe("parseBudgetDirective", () => {
  test.each([
    ["please +500k for this", 500_000],
    ["+2m tokens", 2_000_000],
    ["+1500", 1500],
    ["+1.5k", 1500],
    ["do a thorough job +250K", 250_000],
  ])("%p -> %p", (text, expected) => {
    expect(parseBudgetDirective(text)).toBe(expected)
  })

  test.each([
    ["no directive here", null],
    // Only an explicit +N form counts, so an ordinary number in prose is not mistaken for a budget.
    ["increase it to 500k", null],
    ["version 1.2.3", null],
    ["+0", null],
    ["a+500k", null],
  ])("%p -> %p", (text, expected) => {
    expect(parseBudgetDirective(text)).toBe(expected)
  })

  test("finds a directive at the start of the text", () => {
    expect(parseBudgetDirective("+300k please")).toBe(300_000)
  })
})
