# Epic: async-runs

Status: not started
Estimate: 3 to 5 focused days
Depends on: nothing

## Summary

Today the `workflow` tool call blocks. The model calls the tool, and opencode waits until the whole run finishes. The user waits and watches. A long run pins the turn.

Claude Code runs workflows in the background. Its `Workflow` tool returns a run id at once. The session stays free. The user can keep typing. The result arrives later as a task completion.

This epic gives ultraopen the same contract. The `workflow` tool will return the run id at once. The run will continue inside the opencode server process. A new `workflow_status` tool will let the model ask for progress and fetch the final value. The TUI progress surfaces already read from disk, so they keep working with no change.

From the user experience view: you start a workflow, you keep working, and the result arrives while you do other things.

## UX acceptance criteria

Positive:

- UX: In the live TUI, the strip and the sidebar keep updating after the `workflow` tool returns. Proof: a frame capture in `test/e2e/visual.sh` shows the run alive after the tool call ended.
- UX: The user can send a new prompt while a run is active. Proof: `test/e2e/technical.sh` asserts that a new turn starts and completes while a run is in flight.
- UX: The model calls `workflow_status` with a run id and receives the phase, the agent counts, and, when the run is done, the final value. Proof: integration test.
- UX: When a background run fails, `workflow_status` returns the failure text, the run id, and the run directory. Proof: integration test.

Negative:

- UX: One run produces one result surface. The launch result names the run id and says nothing about the outcome. The status call carries the outcome. Proof: integration test makes sure that the launch result does not contain the final value.
- UX: The user does not lose finished work when they close the session during a run. Proof: integration test kills the process mid-run, restarts, resumes, and makes sure that finished agents replay from the journal.

## Technical acceptance criteria

Positive:

- Unit: with a fake client, the tool returns before the detached run settles. The test uses injected time, no real waits.
- Unit: `beginRun` writes the manifest before the tool returns. The manifest holds the run id, the session id, and the boot id.
- Unit: `workflow_status` reads `progress.json`, `journal.jsonl`, and `result.json` and reports the right counts. It reads from disk only.
- Integration: an abort of the parent turn does not abort a detached run. Only an explicit stop command or a process death ends it.
- Integration: a detached run still honors the per-agent deadline, the concurrency cap, and the budget.

Negative:

- Unit: the status tool never spawns a session.
- Unit: two status calls in a row return the same token count for the same run state. No double counting.
- Unit: an unknown run id returns a clear error, not a crash.

## Task list

Tasks that touch the same file run in sequence.

- [ ] T1 Move the run out of the tool call. `prepare` and the permission ask stay in the tool. The run starts detached. Files: `src/server/index.ts`, `src/server/tool/workflow.ts`, `src/server/singleton.ts` (a detached-run registry). Estimate 1 day.
- [ ] T2 Add the `workflow_status` tool and register it. Files: `src/server/tool/status.ts` (new), `src/server/index.ts`. Estimate 1 day.
- [ ] T3 Rewrite the tool description for the async contract. Update the NOTICE wording for the contract change. Files: `src/server/tool/description.ts`, `NOTICE`. Estimate 0.5 day.
- [ ] T4 Tests, node parity, and e2e updates. Files: `test/index.test.ts`, `test/workflow.test.ts`, `test/e2e/technical.sh`. Estimate 1 to 2 days.