# Lifecycle policy for detached runs

The detached design changes what can end a run. Decide these points before task T1. Record the final decision in this file.

- The run must not die when the tool call returns. Today `context.abort` (the abort signal of the tool call) flows into the Run. A detached run must not take that signal. It needs its own abort controller. The tool call signal is only for the launch phase.
- Stop paths for a detached run: the script ends, the deadline hits an agent, the process dies, or an explicit stop command arrives (the steering epic adds the stop command).
- Policy proposal: an interrupt of the parent turn does not stop the run. The run keeps going. The user stops it with a stop command or by asking the model. This matches Claude Code, where a run carries over when the session leaves.
- Session end: opencode offers no session-end hook to plugins today. The run continues. The reaper handles a dead process. Record the upstream gap here if a future opencode release adds a session-end hook.
- Registry: the detached-run registry maps run id to run state for the status tool and for stop commands. It lives in `singleton.ts`. It holds at most one live run per parent session, because the semaphore is process wide. Decide whether a second `workflow` call from the same session waits, is refused, or runs in parallel. Suggested policy: refuse with a clear message that names the active run. Claude Code allows several, but the refusal is the safer start. Record the decision.

## Decisions recorded (2026-09-15)

- The detached run never takes the tool call's abort signal. The signal covers
  the launch phase only. A parent-turn interrupt leaves the run untouched.
- One live run per launching session: a second `workflow` call from a session
  with a pending or running detached run is REFUSED with a message naming the
  active run id and its directory. The gate covers BOTH contracts — a blocking
  call from the same session is refused too, since mixed contracts would put
  two agent-spending runs in one session. `dryRun` is exempt: it is free,
  stubbed, and the standard way to debug a script mid-run. Refused rather than
  queued because the process-wide semaphore already serializes spawns, and a
  queue with no progress surface reads as a hang. Nested `workflow()` calls are
  unaffected: they never pass through the tool.
- Resume into a live run is refused from ANY session: when the target run id is
  registered live, or its manifest says `running` with a live pid, the launch
  is refused and the caller is pointed at `workflow_status`. Two Run instances
  on one run directory would interleave journal appends and race the endRun
  rewrite. When the owning process is dead (pid not alive), resume is exactly
  the recovery path and stays allowed.
- A `beginRun` failure (unwritable run directory) aborts the launch with a
  clear message instead of starting a run that `workflow_status` could never
  report on. Pre-async this failure was masked; detached it would be invisible.
- The kill switch until the run-control control channel lands: stop the
  opencode process. Finished agents are on disk and a resume replays them.

## Kill switch

If a detached run goes wrong and the process keeps running, the user needs a stop that does not depend on the model. The control channel from the run-control epic covers it. Until that epic lands, document the manual path: delete or mark the run directory, or stop the opencode process.