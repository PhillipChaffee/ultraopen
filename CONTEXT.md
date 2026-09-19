# CONTEXT

The vocabulary of ultraopen — deterministic multi-agent workflow orchestration and the ultracode
effort mode for opencode. Use these terms as defined here; don't drift to synonyms.

## Glossary

**workflow**
A deterministic JavaScript driver in which `agent()` is the only nondeterministic call. Control
flow (loops, fan-out, dedup, thresholds, early exit, synthesis) is real code the author writes;
only the LLM steps vary between runs. A workflow script begins with a pure-literal `meta`.

**run**
One execution of a workflow script. A run has a run id (`wf_…`), a run directory on disk (manifest,
journal, progress, result), and settles into `completed`, `failed`, or `orphaned`. A run belongs to
exactly one session.

**live run**
A run that is still pending or running in the launch-gating registry — not yet settled. The gate,
the resume refusal and the TUI surfaces all key off liveness, not disk status alone.

**launch**
A call to the `workflow` tool that starts (or is refused at) the gate. A launch registers a pending
entry synchronously before its first await, so the check-then-act race cannot admit two.

**launch contract**
Which wait shape a launch follows: `background` (return the run id at once; the run outlives the
tool call) or `blocking` (wait for the final result). Chosen by config precedence — env kill
switch `ULTRAOPEN_WORKFLOW_SYNC=1` > project option `runMode` > home-dir option `runMode` >
built-in default `background` — never by ultracode.

**live-run cap**
The ceiling on live runs in one ultracode-active session: the `ultracodeMaxRuns` plugin option
(default 8). A launch at the cap is refused naming every live run; finishing a run frees a slot.
Non-ultracode sessions hold exactly one live run regardless of the cap.

**demoted session**
A session where the user said some form of "don't fan out". Demotion is prompt-level guidance
only — the launch gate ignores it, and an explicitly requested workflow launches normally.

**leak (e2e)**
Two distinct senses in the e2e suites — keep them apart. A **process leak** is a test-spawned
opencode process that outlives the suite (what the cleanup guarantee targets). **Config
leakage** is the scratch environment inheriting developer-environment state it should not,
through env vars the harness fails to redirect.

**cleanup reaper (e2e)**
The detached watcher one e2e suite run forks at start. It watches the suite script and, when the
script dies for any reason, kills the run's recorded processes, sweeps marker-matched leaks, and
tears down what the EXIT trap would have (scratch, stashed modules, tmux server). Not the plugin's
boot-time crash reaper, which marks dead runs `orphaned` on disk.

**PID manifest (e2e)**
The per-suite-run file in the suite's artifacts dir listing every process the harness spawned
(turn PIDs, the TUI pane pid) with the argv each started with — the cleanup reaper's primary kill
list, with argv matching guarding against a recycled PID. Not a run's `manifest.json`.

## Where decisions live

- `docs/adr/` — accepted decisions, one file each. ADR-0001 records the launch concurrency policy
  (one-live-run refusal, ultracode live-run cap, demotion neutrality, launch-contract neutrality).