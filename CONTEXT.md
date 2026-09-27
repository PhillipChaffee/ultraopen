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

**budget ceiling**
The per-launch output-token ceiling the `budgetTokens` plugin option sets. Once the spend reaches
it, further `agent()` calls throw — and the throw fails the run rather than degrading to a
`null`; the run's failure names the ceiling. Unset or invalid values mean uncapped.

**family ceiling**
The one ceiling a launch family shares: every nested run the launch spawns attaches to the
launching run's spend ledger, so `budget.spent()` reads the whole family. Concurrent launches each
hold their own family ceiling — a session of N live runs can spend N × ceiling, and that is
intended (decided in #32: per-launch ceilings cured by visibility surfaces, not a session ledger).

**budget script global**
The `budget` object a workflow script reads: `{ total, spent(), remaining() }` — the run's family
ceiling, the family's output tokens so far, and what remains (Infinity when uncapped).

**demoted session**
A session where the user said some form of "don't fan out". Demotion is prompt-level guidance
only — the launch gate ignores it, and an explicitly requested workflow launches normally.

**zero-value decoration**
Model weather: emitting `""`, `"null"`, or `"undefined"` for an absent optional `args` field. The
`workflow` tool refuses the three strings loudly at the tool boundary (decided in #86) — the
identity contract is that the script sees exactly what was passed, and a decorated resume hashes
differently from its source baseline, so the argsChanged guard would refuse the replay and the
string would run live. A stop call carrying decoration still stops; the auto-resume sweep and
nested `workflow()` calls are immune by construction.

**args hydration (transport repair)**
A stringified-JSON `args` payload — the failure mode behind poisoned agent prompts (#78). Distinct
from a zero-value decoration: hydration is TRANSPORT repair, restoring the caller's intent, not
normalizing a decoration. At the engine boundary, a string that parses to an object or array is
hydrated to that value (loudly: the manifest records the raw string beside the hydrated value, and
the run log carries the repair line); a string that looks like JSON but fails to parse is refused
before the launch gate; any other string stays a scalar, exactly as passed. Hydration happens
before `argsHash`, so a hydrated launch and an object-args resume replay as the same run. A script
that dereferences `args` (`args.X`, `args["X"]`, `args?.X`, destructuring) is statically flagged,
and the sandbox launch gate throws at script start — zero tokens — when the runtime args is not an
object. The auto-resume sweep passes the stored args through the same boundary, so a poisoned-era
manifest (raw string + string hash) mismatches and stays unadopted — manually resumable — instead
of executing with a seed its journal never used.

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

**input-drop window**
The startup span in which the opencode TUI's terminal-capability queries consume and silently
discard input (~10–11s in tmux, which never answers the probes — opencode issue #42915). It ends
when the queries time out, and no ready signal exposes that moment: health-OK does not close it.
Dropped inputs are swallowed harmlessly, so retrying is safe.

**boot isolation (e2e)**
A V-case's need for its own TUI boot because what it asserts is keyed to the boot's startup
flags. V4 is the canonical case: it asserts a TUI not started with `--auto` surfaces the
approval dialog, which only a fresh no-flag boot proves.

**readiness gate (e2e)**
The verification that an input actually landed before the harness proceeds — the replacement
for fixed settle sleeps, because no upstream signal marks the end of the input-drop window.
Gated once per boot, before the first input-bearing step; later keystrokes are outside the
window.

**open floor**
The `engines.opencode` lower bound, `>=1.18.20`, declared with no ceiling: an opencode older than
the floor loads nothing — the version gate skips the plugin at boot with a version error. The
floor moves only when a feature requires a newer opencode API, never for compatibility
housekeeping; the standing policy is fix forward, gate last (verify upstream majors against the
e2e suites proactively, support both lines with compatible code first, touch the range only as a
last resort — decided in #108, durable record in the README stance line, no ADR).

**sticky cache**
The opencode package cache tree an npm-name plugin installs into: `~/.cache/opencode/packages/<spec>`,
one directory per spec (`ultraopen@latest`, or a pin like `ultraopen@0.1.0` in its own versioned
tree). `@latest` resolves only on first install — a published update never reaches an existing
install on its own, which is what the refresh instruction works around; `-f` rewrites config
entries and never refetches a bare `@latest` (decided in #105).

**refresh instruction**
The canonical sticky-cache refresh shipped with every publish: remove
`~/.cache/opencode/packages/ultraopen*`, then restart opencode. The npm plugin cache is sticky —
`@latest` resolves only on first install — so a new release never reaches an existing install on
its own. Habitual, not situational: it hard-embeds into every release's notes
(`.github/release-template.md`) and the standing README "Updating" note (decided in #108).

**registry hop**
The fetch of a published package from the npm registry into the package cache — the one install
link a packed-tarball proof cannot exercise. Nothing posts or submits anywhere until the hop is
proven live in a scratch home: the installer exits clean, writes both config files, and the e2e
suites pass against the registry-installed tree (decided in #111).

**trusted publisher**
The npmjs.com binding that lets the tag-driven `release.yml` publish to npm via GitHub Actions
OIDC — no npm token exists, none ever will. The first publish (v0.1.0) necessarily went local
over 2FA and ships without provenance; every tag-driven publish after it attests provenance
automatically (decided in #103).

## Where decisions live

- `docs/adr/` — accepted decisions, one file each. ADR-0001 records the launch concurrency policy
  (one-live-run refusal, ultracode live-run cap, demotion neutrality, launch-contract neutrality).