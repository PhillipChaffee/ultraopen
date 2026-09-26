import { describe, expect, test } from "bun:test"
import { assertWithinBudget, makeBudget, makeFamilySpend } from "../src/server/runtime/budget.js"
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

describe("makeFamilySpend", () => {
  test("reads the live sum across attached runs, so it cannot drift from the records", () => {
    const family = makeFamilySpend()
    expect(family.spent()).toBe(0)
    const parent = { outputTokens: 100 },
      child = { outputTokens: 250 }
    family.attach(parent)
    family.attach(child)
    expect(family.spent()).toBe(350)
    // The ledger recomputes from the members' live records — there is no second number to
    // update, so an in-place record change is reflected rather than lost.
    parent.outputTokens = 40
    expect(family.spent()).toBe(290)
  })
})
