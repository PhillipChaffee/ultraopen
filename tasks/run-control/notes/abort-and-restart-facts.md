# Abort and restart facts

- Per-agent abort exists at the bridge level. `spawn.ts` attaches the abort listener before the first await (lines 106 to 108) and calls `client.session.abort` for that child. The listener is removed after the call settles.
- The Run today has only `abortAll` (`runtime/run.ts`). The steering epic adds a map from agent index to its own abort controller. The child signal reaches `spawn.ts` through the per-agent options.
- Journal keys: the key is the scope path, the ordinal, and a hash of the semantic options (`resume/key.ts`). The label and the phase take no part in the key. A restart in place can reuse the same key.
- Journal shape on restart: two options. Append a new entry after the failed one, or rewrite the entry in place. Append is safer for the crash journal, because a rewrite must not lose the failure record. Suggested decision: append, and mark the superseded entry. Record the final decision here before task T4.
- A restart must pass through the concurrency gate and the budget, exactly like a first-run agent call. No shortcut.
- A restarted agent that fails again can be restarted again. Cap the restarts per agent (suggest 3) so a broken agent cannot loop forever. Claude Code bounds its restart key the same way.
- The pause design: the concurrency gate blocks new acquisitions. Agents already in flight finish. The `parallel` combinator starts thunks through the gate, so a paused gate naturally holds unstarted work.

## Decision record (2026-09-13, first slice)

- Journal shape on restart: APPEND a new entry with the same key plus an `attempt` field. The null entry is never mutated — the journal flush appends one line per entry as it is recorded, so a late mutation of the failure entry could never reach disk. Replay is last-wins per key (`Journal.loadPrevious` uses `Map.set`), so the newest `ok` entry replays and the failed entry stays as forensics.
- Trigger for the shipped slice: automatic restart on null reason `idle-deadline` only (the inactivity bound expired). A wall-clock kill (`deadline`) is NEVER restarted: it means the agent produced continuously for the whole ceiling, and a fresh attempt would just re-pay hours of work against a brand-new ceiling. `aborted` is never restarted (it would fight the user); `schema-failed` is owned by the structured ladder; `prompt-failed` is left to opencode's own retry loop.
- Reason vocabulary: `idle-deadline` is a distinct `NullReason` from `deadline`. `DeadlineExceededError` carries a `kind` field (`"idle"` or `"wall-clock"`) that `spawn.ts` maps to the two reasons, so the restart site never has to parse message text.
- Concurrency: a restart REUSES the permit already held by the agent() call. Re-acquiring while holding would deadlock at concurrency 1. The budget is re-asserted per attempt, per the no-shortcut rule.
- Budget accounting: a deadline-killed attempt's output tokens are never observed (the prompt never resolves), so failed attempts record 0 and only the succeeding attempt's spend lands in the run total.
- Abort attribution: a parent abort that lands during a stall can win the race as a deadline kill. The final record and entry report `aborted` when the parent signal is aborted and the raw reason was `deadline`, so the failures list never misattributes the user's own interrupt.
- Crash-time manifest: a restart spawns a NEW child session without an `agent-start`, so the tool's `persistChildren` also runs on `log` events (the restart loop logs once per retry) to keep the reaper's child list current.
- Follow-up (not in this slice): `createChild` (`session.create`) is bounded by neither clock. If the create endpoint hangs, the permit is held indefinitely. Wrap it in a short un-probed deadline when the machinery is next touched.