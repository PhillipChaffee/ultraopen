# ADR-0004: Per-agent transcript recording is always-on disk capture

- **Status:** Accepted
- **Date:** 2026-10-12
- **Deciders:** Phillip Chaffee, deciding during #150's triage grilling (spike evidence on branch `150-transcript-spike`)

## Context

#150 asked to see what an individual workflow agent is doing and to view its transcript. The
fact-finding settled three things:

- The transcript of an `agent()` child — the child session stream — is owned by opencode: the
  plugin can never render bytes inside the transcript flow (ADR-0002: no transcript slot, no
  part-write API). The native path is upstream child-navigation (`session_child_first`,
  `session_child_cycle`, `session_parent` on the current line), which works — for plain agents.
- The live visual-harness probe (2026-10-12, opencode 1.18.33, mixed plain+schema workflow) pinned
  the worst case: a child spawned with a `schema` renders a **completely blank transcript** through
  the native path, live and after settle — `format` poisons the message listing that view reads.
  Only live Bus part events flow regardless. So for the agents most runs spawn, no viewer exists
  at all on the current line.
- The journal deliberately copies values and never points at child sessions (children are
  unreadable when they used `format`, and deleting a parent deletes its children) — so nothing on
  disk holds the full per-agent event stream today.

## Decision

1. **Every agent of every run is recorded, unconditionally.** While a child works, the server
   half's message-part event hook (the idle-deadline's own seam — it already receives every part
   event scoped to engine-owned sessions) appends the events to one append-only JSONL file per
   agent in the run directory. No option, no flag, no failed-agents-only mode; the run
   directory's retention bounds the disk. Opt-in capture rots; failed-only loses the first
   recordings anyone opens; disk is cheap and bounded.
2. **The recording is disk-only and append-only.** Replayed agents (no child session) record
   nothing; aborted, stopped, or crashed children keep exactly what had flowed. No reader ever
   queries historical child sessions through the API: `format` poisoning and parent-delete both
   rule live reads out permanently.
3. **The model side reads the recording through status.** `workflow_status` gains per-agent rows
   (label, status, phase, reason, tokens, child session id, recording path) beside its aggregate
   counts.
4. **The human side is a hint, not a pane.** Launch and agent-row renders name how to open child
   transcripts (the `/sessions` picker, which lists children under `ultraopen · <label>` titles;
   the child-navigation gesture) and carry the session id where one exists. Never positional
   claims: upstream sorts siblings by session id in one place and by creation time in another, so
   locate by title or id, never by order.
5. **The plugin still renders no transcript bytes.** The recording exists so every consumer above
   can read the stream — it is not a UI slice, and the TUI side stays hint-only this decision
   through: selection keys and drill-down panels are future slices with their own evidence spikes
   (the keyboard render-limit constraint stands).

The plugin-side idea this fully rejects, unchanged from ADR-0002: building a second transcript
renderer inside the plugin.

## Consequences

- A schema-forced agent's transcript becomes readable where the native view shows nothing — the
  recording is the only transcript view that covers every agent kind on this line.
- One new file class appears in run directories; readers that walk run dirs must tolerate it like
  every tolerant read. Retention prunes it with the rest.
- Recording is tied to the event hook: events that never arrive (hook gap, older opencode) simply
  leave a shorter recording — the file's absence must never read as a run failure.
- The always-on rule is revisitable only with new evidence (a real disk problem, not a taste); a
  later gate would contradict the "failed-only loses the first recordings anyone opens" finding.
