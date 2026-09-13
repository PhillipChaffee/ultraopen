# What already works without the tool call

The engine already does its long work off the tool result path. This is why the epic is 3 to 5 days and not weeks.

- The journal flush is incremental. One line per entry lands on disk as the run records it. A killed process keeps every finished agent (`src/server/index.ts`, the flush chain).
- The progress writer updates `progress.json` as events arrive (`src/server/resume/progress.ts`).
- The TUI poller reads the run directory once per second. It does not depend on the tool call being alive (`src/tui/data.ts`).
- The reaper uses the boot id to find runs from a dead process (`src/server/resume/reaper.ts`). The manifest records `bootId` and `status` (`src/server/resume/persist.ts`).
- Per-child abort exists at the bridge level. `spawn.ts` attaches an abort listener before the first await and calls `client.session.abort` for the child.

One trap: `runPrepared` ends with `finally { await run.abortAll() }`. That cleanup is tied to the script ending, not to the tool call. In background mode the cleanup must stay tied to the script end. The detached task owns the call to `execute`, so the cleanup follows it.