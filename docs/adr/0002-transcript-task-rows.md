# ADR-0002: Transcript task-style rows come from upstream, not the plugin

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Phillip Chaffee, implementing the upstream-investigation ticket (#33)

## Context

opencode's own task tool fans out subagents, and the transcript shows one task-style row per
child: nested tool calls, live status, the subagent viewer, and a "view subagents" hint. Workflow
agents — the child sessions this plugin spawns — get none of that. The fact-find carried over
from #27's design work was re-verified against upstream main (3dd1b30) during #33 and pinned the
exact linkage:

- The task tool writes tool-part metadata `{ parentSessionId, sessionId, model, background? }`
  (`packages/opencode/src/tool/task.ts`, ~183). Nothing else writes that shape — it is what the
  renderer reads.
- The transcript renders a tool part with the `Task` component only when the tool name is in the
  hardcoded display set ("task"; `packages/tui/src/routes/session/index.tsx` ~2635, component
  ~1765). `Task` reads `metadata.sessionId` (~2222), syncs the child session, renders its nested
  tool calls, and navigates into it.
- The "view subagents" hint is gated on the message containing a `task` part (~1509).
- Child navigation (`ctrl+x down`) ignores tool parts entirely — it keys off session records'
  `parentID` (~206, ~442), which is why it already works for workflow children.

The transcript is out of a TUI plugin's reach by construction, so a plugin-side approximation is
not on the menu at any cost:

- The host slot map has no transcript/message slot (`packages/plugin/src/tui.ts` ~455) — only
  `app`, `app_bottom`, `home_*`, `session_prompt*`, `sidebar_*`.
- The server API exposes no endpoint that writes message parts; parts come into existence only
  through real tool executions (the v2 message group is read-only).
- Prompt-input `agent`/`subtask` parts do not render: `PART_MAPPING` covers only
  `text`/`tool`/`reasoning` (~1578).

The external-slot re-render constraint (documented in `src/tui/index.tsx`) is not even the
binding one here — there is no slot to attach to in the transcript flow at all.

## Decision

1. **File the fix upstream.** A proposal to render task-style rows generically for child sessions
   of the current session is filed at anomalyco/opencode#49801: the route already computes
   `children` from `parentID`, live state is available from `session_status[childID]`, and
   navigation reuses `enterChild`; `task`-part rows stay untouched.
2. **Do not approximate in the plugin.** Every plugin-side construction fails on the verified
   constraints above — no slot, no part-write API, no renderable prompt part. The three existing
   surfaces (strip, sidebar, prompt status) remain the plugin's progress presentation.
3. **Document the interim affordance.** `ctrl+x down` child navigation reaches workflow children
   today; the README's upstream notes record it as the interim path until the proposal lands.

## Consequences

- Until upstream acts, workflow agents stay invisible in the transcript row flow; per-agent
  progress shows on the three surfaces and per-child detail is reachable via `ctrl+x down`.
- When the proposal lands, workflow children get rows with no plugin change — the plugin already
  sets `parentID` on every child (`src/server/bridge/spawn.ts`), which is the only linkage
  generic rendering needs.
- The transcript-echo collapse of the `workflow` call (this epic's original upstream target)
  remains a separate, already-researched proposal (README upstream notes).