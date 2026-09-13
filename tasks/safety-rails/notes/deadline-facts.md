# Deadline facts

- `DEFAULT_AGENT_DEADLINE_MS` is 15 minutes (`src/server/script/limits.ts`). The comment there explains why a ceiling must exist: opencode retries provider failures with no attempt cap, and the retry backoff delay cap is about 24.8 days. A rate-limited agent would pin a concurrency permit forever.
- The deadline is wall clock from the start of the agent. `spawn.ts` wires `onTimeout` to `abortChild`.
- The engine measures the deadline per agent, not per run. A run with many short agents can last hours. The review proved the pain: two runs on 2026-09-12 lost all agents to the 900 second limit, because the provider stalled with no output at all.
- The activity fix needs visibility into child progress. The client can read the child session parts, and the Run already holds each child session id. Poll the child session at the same 1 Hz tick the progress writer uses.
- Design shape: two limits. An inactivity limit (suggest 5 minutes, configuration name `agentIdleMs`) resets on any child progress, and the hard wall clock (`agentDeadlineMs`) stays as the outer bound. Both are configuration values.
- Before any e2e work on the provider path, run `bun run m0`. It is the smoke test for the `json_schema` plus reasoning variant path. That path stalled the fan-out on 2026-09-12 with the togetherai provider, and no test covers it upstream.

## Decision record (2026-09-13)

- Why 15 minutes was kept for so long: it predated the epic plan (commit 40148e8, 2026-08-29) and the plan inherited the constant without re-deriving it. The review sized the design around stalls, and never modeled an agent legitimately working for hours.
- Defaults: `agentIdleMs` 5 minutes, resets on any child progress. `agentDeadlineMs` 4 hours, `0` disables the hard bound entirely.
- Progress signal: the plugin `event` hook. `message.part.updated` and `message.updated` are Bus events carrying the session id; the handler touches `registry` for engine-owned sessions. The SDK's message listing is NOT used: `format` permanently poisons `GET /session/:id/message` for schema'd sessions (`test/upstream-bugs/format-breaks-message-history.mjs`), so polling messages would be blind exactly on the path that stalled. Bus events are the only signal that covers schema'd agents.
- The idle bound fires `DeadlineExceededError` with a `kind: "idle"` and an idle-specific message ("made no progress"), so `spawn.ts` maps the two kill shapes to null reasons `idle-deadline` and `deadline` with one code path. One class, not a subclass: the repo's lint caps one class per file.
- Timer options are clamped to `MAX_TIMER_MS` (2^31-1): the platform clamps setTimeout delays past that down to ~1ms, so an unclamped "huge ceiling to disable the bound" would invert into every agent dying instantly.
- Open verification item: the idle default (5 min) assumes opencode streams part events continuously while the model produces. If part events land only on tool state transitions, a single tool call longer than the idle window would read as idle. Verify the event cadence against a real long-running tool before widening the default; `bun run m0` first on the provider path.