# ultraopen

Deterministic multi-agent workflow orchestration and an `ultracode` effort mode for
[opencode](https://github.com/anomalyco/opencode).

A workflow is a deterministic JavaScript driver in which `agent()` is the only nondeterministic
call. Control flow — fan-out, loops, dedup, thresholds, early exit, synthesis — is real code, so
runs are reproducible.

```javascript
export const meta = { name: 'review', description: 'Review, then verify each finding' }
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
  )),
)
return { confirmed: results.flat().filter(Boolean) }
```

## Status

Working end to end in opencode 1.18.20: the `workflow` tool spawns real parallel subagents and
returns their collected results. Resume, budget ceilings, nested `workflow()`, worktree isolation
and the TUI progress half are not implemented yet.

## Install

Requires a build (`bun run build`), then in `opencode.json`:

```json
{ "plugin": ["/absolute/path/to/ultraopen"] }
```

An absolute path is classified as a file plugin, which skips the version-compatibility gate — so
there is no publish step while iterating.

## Development

```bash
bun install
bun run check   # lint + strict typecheck + tests (95% coverage gate) + Node parity
bun run m0      # provider smoke test against a live model
```

`bun run m0` is a re-runnable health check for the one interaction that cannot be verified from
source: that `format: {type:"json_schema"}` works together with a high reasoning variant, and that
forced tool choice still leaves an agent free to do tool-based research first.

## Not affiliated with Anthropic or the opencode maintainers.
