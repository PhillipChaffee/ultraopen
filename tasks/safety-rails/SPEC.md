# Epic: safety-rails

Status: done 2026-09-16 (T2-T5; T1 landed earlier in PR #17)
Estimate: 3.5 to 6 focused days
Depends on: the budget wiring pairs with async-runs, but the epic can start alone

## Summary

This epic covers three review items: the agent deadline, the cost guardrails, and the approval prompt.

The deadline today is a wall clock of 15 minutes per agent. A provider retry loop can burn all 15 minutes with no output. The agent is then abandoned and the run can fail. The review proved this live: two research runs lost every agent to the deadline. Claude Code has no documented per-agent ceiling, and some real workflow agents run for hours — so a 15-minute ceiling is the bug, not the cure. The revised design gives the two limits different jobs: an activity-based idle limit (default 5 minutes, resets on any child progress) catches stalled agents, and the hard wall clock (default 4 hours, `0` disables it for full Claude Code parity) only bounds a pathological agent that produces forever without finishing. A stalled agent auto-restarts up to 3 times (the run-control T4 slice).

Cost guardrails: Claude Code warns when a run grows large, and its size guideline shapes the scripts the model writes. ultraopen has a budget object in the engine, but the plugin wires no ceiling, and nothing warns about a large run. The work: a token ceiling from configuration, a large-run warning, and size advice in the tool description.

Approval parity: the ask call already sends the workflow name, the description, the phases, and the dry-run flag as metadata, and the always-allow is scoped to the workflow name. The remaining work is to persist the script before the prompt, check that opencode renders the metadata, and document what the user sees.

## UX acceptance criteria

Positive:

- UX: An agent that keeps producing output runs past 15 minutes. Proof: integration test with a fake client that streams progress for longer than the old wall clock. The agent finishes.
- UX: An agent with no progress for the inactivity limit is abandoned, and the failures list names the reason. Proof: unit test with a fake clock.
- UX: When the scheduled agent count passes the warning threshold, the strip shows a large-run warning. Proof: frame capture in `test/e2e/visual.sh`.
- UX: The user can set a token ceiling in the plugin configuration. When the run passes the ceiling, no new agent starts, and the result says why. Proof: integration test.
- UX: The size advice appears in the tool description when the option is set. Proof: unit test on the description text.
- UX: The user can open the script file before approving a run. Proof: integration test makes sure that the script file exists in the run directory before the ask call resolves.

Negative:

- UX: The large-run warning does not pause or stop the run. It is advice only. Proof: integration test.
- UX: A replayed agent does not get free budget. Replayed spend counts as paid. Proof: unit test with a resume over the ceiling.
- UX: A silent agent cannot run forever on activity resets alone. The idle limit ends it within the inactivity window. Proof: unit test with a fake clock and no progress.
- UX: An agent that produces output forever without finishing is still bounded by the hard wall clock. Proof: unit test with a fake clock and continuous progress.
- UX: The permission flow never auto-approves a fan-out. Proof: the existing regression tests for the `ask` default stay green.

## Technical acceptance criteria

Positive:

- Unit: the deadline timer resets on a child progress event and fires only after the inactivity limit without progress. Fake clock.
- Unit: the plugin option `budgetTokens` reaches `budgetTotal` in the workflow context. Nested runs share the parent ceiling. Existing budget tests stay green.
- Unit: the option `sizeGuideline` changes the advice line in the tool description. The line names the agent count target.
- Unit: the large-run warning fires from a scheduled-agent count and a token projection, and both thresholds come from constants.
- Integration: the script source lands in the run directory before the permission ask.

Negative:

- Unit: the activity reset must not stop counting for an agent that streams nothing. No event means the timer runs.
- Unit: the budget does not abort an agent mid-flight. It refuses the next spawn, and the reason lands in the nulls list.
- Unit: the description builder never emits the advice line when the option is unset.

## Task list

- [ ] T1 Activity-based deadline. Files: `src/server/bridge/spawn.ts`, `src/server/runtime/deadline.ts`. Estimate 1 to 2 days.
- [x] T2 Wire the budget option. Files: `src/server/options.ts`, `src/server/index.ts`. Estimate 0.5 to 1 day.
- [x] T3 Large-run warning in the strip and the result. Files: `src/server/runtime/run.ts`, `src/tui/data.ts`, `src/server/tool/render.ts`, `src/server/script/limits.ts` (constants `LARGE_RUN_AGENTS` / `LARGE_RUN_PROJECTED_TOKENS`). Estimate 1 to 2 days. (The warning fires at agent-start and agent-end from the scheduled count and the actual spend, once per run; the result carries a `<large-run>` note and the strip summary gains "· large run" — advice only.)
- [x] T4 Size advice in the description builder. Files: `src/server/tool/description.ts` (`withSizeAdvice`), `src/server/index.ts`. Estimate 0.5 day.
- [x] T5 Persist the script before the ask, and document the prompt contents. Files: `src/server/index.ts`, `README.md`. Estimate 0.5 day. (The open question from permission-prompt-facts — whether opencode renders ask `metadata` — moved to the upstream-fixes epic with the dialog-drift evidence from the visual suite: on 1.18.31 the dialog auto-resolves and "Permission required" never renders, so the metadata question needs a live manual check, not a headless probe.)

## Task list note

T1 (activity-based deadline) shipped in PR #17. The large-run advice is a NEW
slice folded into T3's scope: it fires at agent-start (count threshold) and
agent-end (token projection), never stops anything, and both thresholds are
constants in `src/server/script/limits.ts` shared by the run log, the result
note, and the strip badge.