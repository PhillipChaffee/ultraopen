# Compatibility and known limits

Verified against opencode 1.18.31 by the live e2e suites (`test/e2e/technical.sh`,
`test/e2e/visual.sh`). Each probe carries a `bun run check`-clean implementation note in the
suites.

## Working end to end

- the background contract end to end (launch handle, per-turn live-run reminder, completion
  notification in the parent session, `workflow({ stop })`, auto-resume after a process death)
- parallel and pipeline fan-out
- schema-forced structured output
- per-model effort resolution
- resume across processes (journal replay returns the recorded values)
- nested `workflow({ script })`
- the per-agent idle limit and wall clock
- all four ultracode activation surfaces
- the three TUI progress surfaces

## Known gaps the e2e probes confirmed

- `agent()`'s `isolation: "worktree"` option is inert in the live wiring (`worktreeRoot` is
  never passed).
- Schema-forced agents (`schema:` on `agent()`) can fail against Together with an empty
  `APIError` when ANY tool in the session's toolset carries a `$ref` in its JSON Schema (some
  MCP servers do — Obsidian's `vault_patch` does). Together's grammar compiler misresolves
  `$ref` pointers under the string form of `tool_choice: "required"` that opencode sends for
  `format` calls; the identical request succeeds with the object form. Workaround: disable the
  offending MCP server, or run those agents schema-less.
- The permission approval dialog renders without the ask's `metadata` (the workflow name,
  description and phases) on 1.18.31.
- Workflow agents do not get transcript task-rows — the renderer builds those only from the
  built-in task tool's parts (the row's child-session id lives in the part's
  `metadata.sessionId`, which only the task tool writes), so a workflow's child sessions show no
  transcript rows no matter what a plugin does. Per-agent progress shows on the three TUI
  surfaces, and `Ctrl-x` then `down` navigates into each child session today. The upstream
  proposal to render parented children generically is filed (policy and evidence in
  [docs/adr/0002-transcript-task-rows.md](./adr/0002-transcript-task-rows.md)).

The task-row, dialog and `$ref` gaps need upstream fixes; the transcript-echo collapse (this
epic's original upstream PR target) is researched and ready to submit separately.

## Cosmetic limitations (upstream)

- The transcript renderer echoes a tool call's raw arguments, so a `workflow` call displays its
  full script (visible in the README's first screenshot).
- An open sidebar renders one blank line when no runs are active.
- A failed agent's glyph keeps the muted color of its line (a single `<text>` node carries one
  fg color) — the strong `✗` marker, the per-row failure reason, and the summary's failed count
  carry the signal instead.
- A half-failed run shows a failed count while live.
- An interrupted run (its process died) shows a once-only resume hint in the strip: the first
  boot that displays the hint removes its marker, so later starts show nothing.
- The TUI hides synthetic user messages from the visible timeline (`!part.synthetic` filter,
  1.18.x), so a `<workflow-completed>` notification never renders as its own row — what you see
  is the turn it starts (the model replying to the result), and what you get is the outcome. The
  e2e suites assert the notification at the session-database level for exactly this reason.