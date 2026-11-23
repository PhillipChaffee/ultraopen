# Compatibility and known limits

Verified against opencode V2.3.2 (`>= 2.3.2 < 3`) by the live e2e suites
(`test/e2e/technical.sh`, `test/e2e/visual.sh`). Each probe carries a `bun run check`-clean
implementation note in the suites. The V1 line is frozen at `0.1.0` and is not covered here.

## Working end to end

- the background contract end to end (launch handle, per-turn live-run reminder, synthetic
  completion notification, `workflow({ stop })`, auto-resume after a process death)
- parallel and pipeline fan-out
- schema-forced structured output through the V2 `StructuredOutput` capture tool (no V1
  `format`, no history poisoning)
- per-model effort resolution (`experimental.model.resolve`)
- resume across processes (journal replay returns the recorded values)
- nested `workflow({ script })`
- the per-agent idle limit and wall clock
- all four ultracode activation surfaces
- the reactive TUI surfaces (`session.composer.top`, `sidebar.content`, `prompt.footer`), the
  `/workflows` panel, direct `/workflow-stop`, and `◈` synthetic transcript rows
- live transitive parent permission inheritance (`#149`) and `isolation: "worktree"` child
  creation
- per-agent JSONL recordings (`ADR-0004`)

## Known gaps the V2.3.2 probes confirmed

- **Workflow children are not in V2's native `down` picker.** They are created without
  `parentID` by design: V2's `SubagentReport` wakes and steers the parent for every session that
  carries one. Lineage lives in `metadata.ultraopen`; child inspection uses the `/workflows`
  panel, `/sessions` titles (`ultraopen · <label>`), and the recordings.
- **No transcript or custom tool-renderer slot.** V2's `GenericTool` renders `⠋`/`✓`/`✗ workflow`
  and ignores tool metadata. The plugin's surfaces are the reactive slots, the `/workflows`
  panel, `ctx.session.synthetic` (`◈ <description>`), and the recordings.
- **Shell-wrapper gap on a shared service.** `shell.hook("create.before")` fires before
  `OPENCODE_SESSION_ID` is set and `Plugin.Context` exposes no `session.environment`. The plugin
  correlates owned child shells (`pendingChildShells` → `ULTRAOPEN_ACTIVE=1`); the residual edge
  is a non-`opencode` wrapper binary talking directly to an already-running `shared-service`
  daemon.
- **No `permission.saved.list`.** Saved `Allow always` policies cannot be enumerated through
  `Plugin.Context`. Child requests are evaluated against the host's effective policy and fail
  closed wherever a saved allow cannot be verified to preserve the child's narrower bounds.
- **Custom user primary agents defined only in config appear after plugins.** Config agents are
  applied in `post`, so `agent.transform` sees built-ins and `ultracode` only. Custom subagents
  are stripped in `hook("context")` and refused in `execute()`; custom primary agents fall back
  to explicit `opencode.json` permission rules.
- **`hook("context")` exposes no `toolChoice`.** The plugin keeps the three-attempt same-session
  retry ladder with in-loop `Tool.Error` validation feedback and never parses assistant prose.

## Cosmetic limitations (upstream)

- The transcript renderer echoes a tool call's raw arguments, so a `workflow` call displays its
  full script (visible in the README's first screenshot). V2's `GenericTool` ignores metadata, so
  the plugin cannot replace that row.
- An open sidebar renders one blank line when no runs are active.
- A failed agent's glyph uses the line's muted color where the host paints a single text node; the
  strong `✗` marker, the per-row failure reason, and the summary's failed count carry the signal.
- A half-failed run shows a failed count while live.
- An interrupted run (its process died) shows a once-only resume hint in
  `session.composer.top`: the first boot that displays the hint removes its marker, so later
  starts show nothing.
