# Control channel design

The TUI plugin and the server plugin are separate entries in separate processes. They share the run directory on disk.

- Progress flows server to TUI: the server writes `progress.json`, the TUI reads it.
- Control flows the other way: the TUI writes, the server reads.

Shape:

- One control file per run: `runDir/runId/control.jsonl`. One JSON line per command.
- Command shape: `{ seq, action, target }`. Actions: `pause`, `resume`, `stop-run`, `stop-agent`, `restart-agent`. Target is the agent index for the agent actions.
- The server reads the file on the same 1 Hz tick as the progress writer. It runs the commands in order and writes back a cursor (the highest processed seq) into the same file or a cursor file, so a replayed command does not act twice.

Rules:

- Idempotence: a command with a sequence number at or below the cursor is skipped.
- Scope: the control file lives in the run directory of one run, so cross-run commands cannot exist. Still make sure that a command naming a foreign run id is ignored.
- Crash safety: a command consumed but not acknowledged runs again. Every action must be safe to run twice. Pause, resume, and stop are naturally safe. Restart-agent needs the idempotence guard from the journal.
- Security: the run directory sits under the opencode tool-output directory. Local user only. No remote surface reads it.

Open question for task T1: does the TUI plugin have a client to the opencode server? `src/tui/data.ts` reads directories. If the TUI can call the server API directly, a control tool call may be simpler than a file. Decide after a spike, and record the decision here. The file channel is the fallback and is proven by the progress pattern.