# Epic: run-control

Status: partial 2026-09-16 (T1 control channel, T2 pause/resume, T3 per-agent stop, T6 token counts shipped; T4 manual restart keys, T5 TUI selection, T7 detail view deferred)
Estimate: 9 to 12 focused days
Depends on: the control channel is the foundation. The keyboard resume and the drill-down build on it

## Summary

The TUI progress today is read-only. The user sees a strip, a sidebar, and a prompt status line, all fed by one poller. They cannot stop one agent, pause a run, or restart an agent. The only lever is interrupting the whole turn. Claude Code gives keys in its workflows view: pause, stop one agent, restart, filter, save.

This epic adds the same control to the ultraopen sidebar, plus two observability items: per-agent token counts and a drill-down view of what an agent is doing. It also adds a keyboard resume for a finished or failed run.

The control path: the TUI plugin and the server plugin run in different processes. They already share the run directory on disk. Progress flows server to TUI through files. Control flows the other way: the TUI writes a control file, and the server reads it.

From the user experience view: watching a run becomes managing a run. You select an agent, stop the one that went sideways, pause the rest, and resume the run when you are ready.

## UX acceptance criteria

Positive:

- UX: The arrow keys select an agent row in the sidebar. The selected row is visually distinct. Proof: frame capture in `test/e2e/visual.sh`.
- UX: The `x` key stops the selected agent. The row shows the stopped state and the reason. Proof: frame capture plus integration test that the child session is aborted.
- UX: The `p` key pauses the run. No new agent starts while paused. The `p` key again resumes. Proof: e2e test with a run wide enough to show the pause.
- UX: The `r` key restarts a stopped or failed agent. Proof: e2e test.
- UX: Each agent row shows its output tokens. Proof: frame capture.
- UX: The Enter key opens the agent detail: the prompt and recent tool calls with their states. Proof: frame capture.
- UX: On a finished or failed run, a resume key reruns the script with the journal replayed. Proof: e2e test on a run with two completed agents.

Negative:

- UX: The keys do nothing when no run is active. Proof: frame capture at rest, plus an integration test that a stray control command does not touch a finished run.
- UX: A stop on one agent does not touch its siblings. Proof: integration test.
- UX: A pause does not cancel agents in flight. They finish. Proof: integration test.

## Technical acceptance criteria

Positive:

- Unit: the control file parser accepts one JSON command per line and ignores malformed lines. Commands run in sequence order.
- Unit: pause blocks new acquisitions on the concurrency gate. Resume releases them. Extend the existing semaphore tests.
- Unit: per-agent stop maps to the child session abort, and no sibling is touched.
- Unit: a restart in place reuses the same journal key, records a new entry, and marks the old entry superseded. A later `resumeFromRunId` replay stays correct.
- Unit: the Run captures output tokens per agent from the child session.
- Integration: a command written into the control file is processed within one poll tick.

Negative:

- Unit: an unknown control command is ignored and logged, not a crash.
- Unit: the Run ignores a control command whose run id does not match. The control file lives in the run directory of one run only.
- Repo rule: the TUI code must not rely on reactive insertion after mount. A grep test or lint rule makes sure that new surfaces use the imperative render path.

## Task list

- [x] T1 Control channel: the server watches `control.jsonl` in the run directory (one JSON command per line; a memory cursor skips consumed sequences; malformed lines ignored). Files: `src/server/runtime/control.ts` (new), `src/server/runtime/run.ts` (`handleControl`), `src/server/index.ts` (the per-run watcher, cleared at settle). Estimate 1 day. (Open question resolved: the TUI writes the FILE — the file channel is proven by the progress pattern and needs no client.)
- [x] T2 Pause and resume on the concurrency gate. Files: `src/server/runtime/semaphore.ts`, `src/server/runtime/run.ts`. Estimate 1 day. (Pause holds new acquisitions; in-flight permits are never revoked; resume drains FIFO.)
- [x] T3 Per-agent stop: a per-agent AbortController combined with the run signal into the bridge options; stopping one agent aborts exactly its child. Files: `src/server/runtime/run.ts` (`agentSignal`, `handleControl`). Estimate 1 day.
- [ ] T4 Restart-in-place manual keys: the journal machinery ships (auto-restart, PR #17); the control command exists and is parsed, and currently logs that it is not implemented — the in-flight path (synthetic idle-deadline abort) and the finished/failed path (journal restart) land with T5. Estimate 1 day.
- [ ] T5 TUI selection, key handling, and imperative rendering: NOT STARTED (highest risk; needs the live keyboard spike the render-limit notes prescribe). Files: `src/tui/index.tsx`, `src/tui/data.ts`. Estimate 2 to 3 days.
- [ ] T4 Restart in place, first slice shipped 2026-09-13: a `deadline` null auto-restarts the agent up to 3 times, reusing the held concurrency permit and re-asserting budget per attempt. Each attempt appends its own journal entry with the same key and an `attempt` field; the newest `ok` entry wins replay. Remaining for the full task: manual/TUI restart keys via the control channel (T1/T5). Files: `src/server/runtime/run.ts`, `src/server/resume/key.ts`. Estimate 1 to 2 days.
- [ ] T5 TUI selection, key handling, and imperative rendering. Files: `src/tui/index.tsx`, `src/tui/data.ts`. Estimate 2 to 3 days. Highest risk in this epic.
- [x] T6 Token counts per agent in the sidebar. Files: `src/server/runtime/run.ts` (agent-end events carry outputTokens), `src/server/resume/progress.ts` (snapshot rows), `src/tui/data.ts` (`agentRowText` renders `· 1.3k`). Estimate 1 to 1.5 days.
- [ ] T7 Detail view with tool calls. Files: `src/tui/index.tsx`, `src/tui/data.ts`. Estimate 2 to 3 days. Read the open question in the notes first.