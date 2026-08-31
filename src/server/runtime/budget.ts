import { fail } from "../script/errors.js"

/**
 * The token budget exposed to a script as `budget`.
 *
 * A HARD ceiling, not advisory: once spend reaches the target, further `agent()` calls throw. That
 * is what makes the documented `while (budget.total && budget.remaining() > 50_000)` loop
 * terminate rather than run to the agent cap.
 *
 * `total` is null when no target was set, and every documented loop guards on it — without a
 * target `remaining()` is Infinity, and an unguarded loop would run to the 1000-agent backstop.
 */

export type Budget = {
  total: number | null
  spent: () => number
  remaining: () => number
}

export type BudgetOptions = {
  total: number | null
  /** Output tokens spent so far. Live, because it grows as agents complete. */
  spent: () => number
}

export function makeBudget(options: BudgetOptions): Budget {
  return {
    total: options.total,
    spent: options.spent,
    remaining: () => (options.total === null ? Number.POSITIVE_INFINITY : Math.max(0, options.total - options.spent())),
  }
}

/**
 * Enforces the ceiling before a call is made.
 *
 * Checked at `agent()` entry rather than after: spending past the target and then reporting it
 * would defeat the point of a ceiling. In-flight calls are allowed to finish, since cancelling
 * work already paid for wastes it.
 */
export function assertWithinBudget(budget: Budget): void {
  if (budget.total === null) return
  if (budget.spent() < budget.total) return
  fail({
    kind: "LimitError",
    message: `Workflow reached its ${budget.total} output-token budget (spent ${budget.spent()}).`,
    suggestions: [
      "Guard loops on `budget.total && budget.remaining() > <headroom>` so they stop before the ceiling.",
      "Raise the target, or split the work across several workflow runs.",
    ],
  })
}

/**
 * Reads a `+500k`-style token target out of a user's message.
 *
 * opencode has no such convention of its own, so this is a private one — recognised only in an
 * explicit `+N` form to avoid mistaking an ordinary number in prose for a budget.
 */
export function parseBudgetDirective(text: string): number | null {
  const match = /(?:^|\s)\+(\d+(?:\.\d+)?)\s*([km])?\b/iu.exec(text)
  if (!match) return null

  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return null

  const unit = match[2]?.toLowerCase()
  if (unit === "k") return Math.round(amount * 1000)
  if (unit === "m") return Math.round(amount * 1_000_000)
  return Math.round(amount)
}
