# Budget facts

- The engine has a budget. `runtime/budget.ts` exposes `makeBudget`, and the script sees `budget` as `{ total, spent(), remaining() }`.
- Nested runs share the parent ceiling. `tool/workflow.ts` passes `parentRun.budget.total` into the child context.
- The top-level plugin wires no ceiling today. `index.ts` never passes `budgetTotal`, so the run ceiling is null.
- Spent means output tokens of agents. Replayed spend counts as paid (`run.ts`). This keeps a budget-guarded loop stable across resumes.
- `assertWithinBudget` runs before each spawn. A refused spawn produces a null with a reason. Make sure that the reason text names the budget, so the failures list explains itself.

Wiring plan:

1. New plugin option `budgetTokens` (number). `resolveOptions` validates it as a positive number. No ceiling when unset, to keep today's behavior.
2. `index.ts` passes `budgetTotal: options.budgetTokens` into the workflow context when set.
3. Document the option next to `concurrency` and `agentDeadlineMs` in the README.

Open question for the warning task: the large-run warning in Claude Code projects tokens before the run starts. ultraopen knows the scheduled count only after the first combinator call. Fire the warning at spawn time from the count and the token spend so far. Record the exact trigger here after T3.