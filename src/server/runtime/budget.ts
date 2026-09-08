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

export interface Budget {
  total: number | null
  spent: () => number
  remaining: () => number
}

export interface BudgetOptions {
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
 * work already paid for wastes it. Concurrency makes the ceiling granular, not exact: calls
 * fanned out in the same tick all pass the check before any of them reports spend, so a burst
 * near the target can overshoot by (concurrency − 1) × one agent's spend. Guarding loops on
 * `remaining()` with headroom, as the suggestion below says, keeps that gap harmless.
 */
export function assertWithinBudget(budget: Budget): void {
  if (budget.total === null) {return}
  if (budget.spent() < budget.total) {return}
  fail({
    kind: "LimitError",
    message: `Workflow reached its ${budget.total} output-token budget (spent ${budget.spent()}).`,
    suggestions: [
      "Guard loops on `budget.total && budget.remaining() > <headroom>` so they stop before the ceiling.",
      "Raise the target, or split the work across several workflow runs.",
    ],
  })
}
