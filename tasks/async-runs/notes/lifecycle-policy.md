# Lifecycle policy for detached runs

The detached design changes what can end a run. Decide these points before task T1. Record the final decision in this file.

- The run must not die when the tool call returns. Today `context.abort` (the abort signal of the tool call) flows into the Run. A detached run must not take that signal. It needs its own abort controller. The tool call signal is only for the launch phase.
- Stop paths for a detached run: the script ends, the deadline hits an agent, the process dies, or an explicit stop command arrives (the steering epic adds the stop command).
- Policy proposal: an interrupt of the parent turn does not stop the run. The run keeps going. The user stops it with a stop command or by asking the model. This matches Claude Code, where a run carries over when the session leaves.
- Session end: opencode offers no session-end hook to plugins today. The run continues. The reaper handles a dead process. Record the upstream gap here if a future opencode release adds a session-end hook.
- Registry: the detached-run registry maps run id to run state for the status tool and for stop commands. It lives in `singleton.ts`. It holds at most one live run per parent session, because the semaphore is process wide. Decide whether a second `workflow` call from the same session waits, is refused, or runs in parallel. Suggested policy: refuse with a clear message that names the active run. Claude Code allows several, but the refusal is the safer start. Record the decision.

## Kill switch

If a detached run goes wrong and the process keeps running, the user needs a stop that does not depend on the model. The control channel from the run-control epic covers it. Until that epic lands, document the manual path: delete or mark the run directory, or stop the opencode process.