# Epic: reliability-ux

Status: done 2026-09-16 (T1-T3; T4 deferred, see below)
Estimate: 2 to 3 focused days
Depends on: nothing hard. The failure display shares the render pattern with run-control, so read that epic's notes.

## Summary

Two review items live here: failure display and crash recovery.

When an agent fails, the sidebar shows the failed glyph in the same muted color as the rest of the line. The failures list lands only in the tool result, after the run ends. A half-failed run is easy to miss. When the process dies mid-run, the reaper marks the run interrupted at the next load, but nothing tells the user that a run died, and nothing offers the resume.

This epic makes failures visible while the run is live, and puts a resume offer on the screen after a crash.

From the user experience view: you see at a glance that an agent failed, and after a crash you see exactly which run was interrupted and how to bring it back.

## UX acceptance criteria

Positive:

- UX: The failed agent glyph uses the error color. Proof: frame capture in `test/e2e/visual.sh` shows a failed row with a distinct color while the line text keeps its muted tone.
- UX: The strip shows a failed count while the run is live, in the form of a count next to the agent progress. Proof: frame capture with one failed agent in flight.
- UX: After a crash, the next start shows a hint for each interrupted run. The hint names the run id and says that the user can ask for a resume. Proof: e2e test kills the server mid-run, restarts, and captures the frame.
- UX: The sidebar lists the failed agents with their reasons on expansion. Proof: frame capture.

Negative:

- UX: The hint appears once per run, not on every load. Proof: integration test makes sure that a second load shows no new hint for a run the user has seen.
- UX: Runs that completed before the crash show no hint. Proof: unit test over the hint filter.
- UX: A missing or malformed state file never blocks startup. Proof: unit test with a malformed file.

## Technical acceptance criteria

Positive:

- Unit: the reaper writes the interrupted run ids to a file that the TUI reads.
- Unit: the strip line builder adds the failed count from the progress data.
- Unit: the hint persists until the run is resumed or the retention window prunes it. A marker per run drives the once-only behavior.
- Integration: after the hint, a resume with `resumeFromRunId` replays the finished agents. The existing resume path stays untouched.

Negative:

- Unit: the hint never fires for a manifest with status `completed` or `failed`.
- Unit: TUI startup cost does not grow with the number of old runs. The hint read is one directory pass, not a full scan.

## Task list

- [x] T1 Error color for the failed glyph. Files: `src/tui/index.tsx`. Estimate 0.5 day. (Implemented via the library's rich-text path: a statically-mounted parent <text> whose children are pre-created renderables, mutated imperatively per poll — the failed glyph gets `theme.error`. If the child API drifts, the render degrades to the spec's documented fallback: strong ✗ markers plus the summary's failed count. test/e2e/visual.sh V2c asserts the distinct SGR color and the markers.)
- [x] T2 Failed count in the strip. Files: `src/tui/data.ts`, `src/tui/index.tsx`, and the progress writer if it needs a counter. Estimate 0.5 day. (No writer change needed: `progress.json` agents carry live status, and `summarize` already renders `· N failed`; visual.sh V2c asserts it with one failed agent in flight.)
- [x] T3 Interrupted-run hint. Files: `src/server/resume/reaper.ts`, `src/tui/data.ts`, `src/tui/index.tsx`. Estimate 1 day. (Decision: the reaper writes `interrupted.txt` per orphaned run — one marker per run, the once-only driver. The TUI reads all markers in ONE directory pass at boot and caches them, so startup cost does not grow with old runs. Display is once per boot, in the strip, and names the run id and the resume path.)
- [ ] T4 Session-level hint, optional. A synthetic note in the message transform names the interrupted run for the model. Files: `src/server/ultracode/hooks.ts`. Estimate 0.5 day. Decide with the owner whether the model needs this or the TUI hint is enough. DEFERRED: the model already sees an orphaned run through `workflow_status`, whose orphaned status carries a resume pointer — a second injection surface would duplicate that. Revisit if live use shows the model missing orphaned runs.