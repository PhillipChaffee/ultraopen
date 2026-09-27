# The launch contract and run lifecycle

## The launch contract

The `workflow` tool returns immediately with a `<workflow-launched>` result naming the run id and
directory — it never contains the outcome. In a long-lived host (TUI, `serve`, `web`, `acp`, the
`--mini` REPL) the result tells the model to end its turn once the run is launched and to poll
`workflow_status(runId, { wait })` when you ask about the run — you keep chatting while the run
works. In one-shot `opencode run` the process exits right after the turn, so the result instead
keeps the turn alive: the model polls until the run settles — an unsettled run dies with the
process (its completed agents survive on disk and a later `resumeFromRunId` replays them). Old
synchronous behavior: `"runMode": "blocking"` or env `ULTRAOPEN_WORKFLOW_SYNC=1`; `dryRun` always
waits.

How many runs one session may hold is ultracode-conditional — policy and rationale in
[docs/adr/0001-launch-concurrency-policy.md](./adr/0001-launch-concurrency-policy.md): a
non-ultracode session holds exactly one live run; an ultracode-active session holds up to
`ultracodeMaxRuns`, and finishing any run frees a slot. Saying "don't fan out" changes the
standing guidance, never the gate; `dryRun` is exempt; resuming a still-executing run is refused
— two engines would write one journal.

## Stopping a run

Interrupting the turn (ESC) never stops a background run — the launch result says so, and the
sidebar carries the same hint: to stop a detached run, call `workflow({ stop: "<runId>" })`. Its
subagents abort, the run is recorded `cancelled`, a `<workflow-stopped>` confirmation hydrates
into the run's session, and no completion notification follows — a run you stopped must never
appear to have finished on its own. A run owned by another process must be stopped from that
session, and a stop call that cannot act returns a clear refusal.

## The notification

When a detached run settles, the outcome is delivered to the run's session: a synthetic message
wrapping the same render the blocking result carries, capped at 4096 characters (cut at a line
boundary) with a pointer line to the full `result.json` or `failure.txt`. If the turn ended
exactly as the notification landed, one idle nudge re-fires it — once per run, ever. While the
run is live, each turn also carries an ephemeral one-line reminder naming the run id, the
workflow, and its elapsed time — what keeps the model from duplicating work already in flight.

## Auto-resume

A detached run survives process death up to its journal: on the next start, runs the dead
process interrupted re-execute automatically under the same run id — completed agents replay
from the journal, the missing tail re-runs, and the original session is hydrated with the
outcome. Guards keep it bounded: the interruption must be younger than `autoResumeTtlHours`, at
most `autoResumeMax` runs adopt per boot, oldest first, a run stopped by request never resumes,
and the stored args must still hash to the run's manifest.