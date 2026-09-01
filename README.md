# ultraopen

Deterministic multi-agent workflow orchestration and an `ultracode` effort mode for
[opencode](https://github.com/anomalyco/opencode).

A workflow is a deterministic JavaScript driver in which `agent()` is the only nondeterministic
call. Control flow — fan-out, loops, dedup, thresholds, early exit, synthesis — is real code, so
runs are reproducible and resumable.

```javascript
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
  )),
)

return { confirmed: results.flat().filter(Boolean) }
```

## What you get

- **`workflow` tool** — runs a script that fans out across parallel subagents, with `pipeline`
  (no barrier between stages) and `parallel` (a barrier over thunks). Scripts can be passed inline
  or by path (`scriptPath`), and a previous run can be replayed with `resumeFromRunId`.
- **Schema-forced output** — `agent(prompt, { schema })` returns a validated object, with a
  three-attempt same-session retry ladder.
- **Resume** — `resumeFromRunId` replays unchanged calls instantly; the first edited call and
  everything after it in the same scope runs live. Failed runs keep their partial journal, so a
  resume replays the agents that already succeeded.
- **`ultracode` mode** — raises reasoning effort and makes fan-out the default. Four ways in: the
  `ultracode` agent, the keyword, `/ultracode`, or a project config flag.
- **Progress** — a bottom strip, a sidebar panel, and a prompt-row status line, all served by one
  shared poller.
- **Safety** — a five-layer recursion guard, a wall-clock deadline per agent, a global concurrency
  cap, budget ceilings, an orphan reaper that releases subagents left by a killed server (skipping
  runs whose process is still alive), and retention pruning of finished run directories.

## Install

Build first, then reference it from both config files. TUI plugins are read only from `tui.json`;
`opencode.json`'s `plugin` array never reaches the TUI runtime.

```bash
bun install && bun run build
```

```jsonc
// opencode.json
{ "plugin": ["/absolute/path/to/ultraopen"] }

// tui.json  — for the progress display
{ "plugin": ["/absolute/path/to/ultraopen"] }
```

An absolute path is classified as a file plugin, which skips the version-compatibility gate, so
there is no publish step while iterating.

Options go through the tuple form — never a new top-level key, which opencode hard-rejects:

```json
{ "plugin": [["/path/to/ultraopen", { "concurrency": 8, "ultracode": true }]] }
```

## Development

```bash
bun run check   # lint + strict typecheck + tests (95% coverage gate) + Node parity
bun run m0      # provider smoke test against a live model
```

`bun run m0` is a re-runnable health check for the one interaction that cannot be verified from
source: that `format: {type:"json_schema"}` works together with a high reasoning variant, and that
forced tool choice still leaves an agent free to research first. Upstream has no test coverage for
that path, so it can regress silently in an opencode release.

## Status

Verified against opencode 1.18.20. Working end to end: parallel and pipeline fan-out, schema-forced
structured output, per-model effort resolution, resume across processes, nested `workflow()`,
budget ceilings, worktree isolation, and all four ultracode activation surfaces.

One cosmetic limitation is upstream: the transcript renderer echoes a tool call's raw arguments,
so a `workflow` call displays its full script. The progress surfaces (strip, sidebar, prompt
status) are where live state shows.

See [NOTICE](./NOTICE) for attribution.
