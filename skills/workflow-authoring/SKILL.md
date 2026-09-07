---
name: workflow-authoring
description: Reference for writing a workflow script for the ultraopen `workflow` tool — the script API, the rules the engine enforces, and the patterns worth composing. Read this before authoring a script.
---

# Writing a workflow script

A workflow is a deterministic JavaScript driver in which `agent()` is the only nondeterministic
call. Control flow — fan-out, loops, dedup, thresholds, early exit, synthesis — is real code you
write. That property is what makes runs reproducible and resumable.

## Anatomy

```javascript
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [{ key: 'bugs', prompt: '...' }, { key: 'perf', prompt: '...' }]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v }))
  )),
)

return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }
```

`meta` must be the FIRST statement and a PURE LITERAL — no variables, calls, spreads or template
interpolation. It is read statically, before any code runs, so the permission prompt can name the
workflow.

## Globals

| | |
|---|---|
| `agent(prompt, opts?)` | Spawns a subagent. Returns its final text, or the validated object when `schema` is set. Returns `null` when it produced nothing usable — always `.filter(Boolean)`. |
| `pipeline(items, ...stages)` | Each item flows through every stage independently, with NO barrier. Stage callbacks get `(prevResult, originalItem, index)`. |
| `parallel(thunks)` | A BARRIER over an array of FUNCTIONS (`() => agent(...)`), not promises. |
| `phase(title)`, `log(msg)` | Progress narration. |
| `args` | Whatever was passed as `args`, verbatim. |
| `budget` | `{ total, spent(), remaining() }`. A hard ceiling. |
| `workflow({ script }, args?)` | Runs another workflow inline, `{ script }` form only — the named form throws because the shipped plugin never populates `context.named`. One level only. THROWS on failure, unlike `agent()`. |

`agent()` opts: `label`, `phase`, `schema`, `model`, `effort`, `agentType`, `isolation`,
`disallowedTools`.

## Choosing between pipeline and parallel

**Default to `pipeline`.** Use a `parallel` barrier only when a stage genuinely needs ALL of the
previous stage's results together — to dedup across the whole set, to early-exit on zero findings,
or to compare findings against each other.

"I need to flatten or filter first" is not a reason: do that inside a pipeline stage. Barrier
latency is real — if five finders run and the slowest takes three times the fastest, a barrier
wastes the fast ones' idle time.

## Rules the engine enforces

- **Plain JavaScript.** Type annotations, interfaces and generics fail to parse.
- **No clock, no randomness.** `Date.now()`, `Math.random()` and argless `new Date()` are rejected
  because they break resume. Pass timestamps via `args`; vary behaviour by index.
- **No imports, no filesystem, no Node globals.** Delegate that to an `agent()`.
- **Limits:** 1000 agents per run, 4096 items per `parallel`/`pipeline` call, 524288 characters of
  script. Exceeding one is an explicit error, never a silent truncation.

## Patterns

- **Adversarial verify** — several independent skeptics per finding, each asked to REFUTE it. Kill
  it if a majority refute. Stops plausible-but-wrong findings surviving.
- **Perspective-diverse verify** — when something can fail in more than one way, give each verifier
  a distinct lens (correctness, security, performance, does-it-reproduce) rather than N identical ones.
- **Judge panel** — generate N attempts from different angles, score with parallel judges, then
  synthesize from the winner while grafting the best ideas from the runners-up.
- **Loop-until-dry** — for unknown-size discovery, keep spawning finders until K consecutive rounds
  return nothing new. Dedup against everything SEEN, not everything confirmed, or rejected findings
  resurface forever and the loop never terminates.
- **Multi-modal sweep** — parallel agents each searching a different way, since one angle rarely
  finds everything.
- **Completeness critic** — a final agent asking "what is missing?" What it finds becomes the next round.

## Debugging

Pass `dryRun: true` to run the whole script with `agent()` stubbed out — it exercises parsing,
control flow and fan-out shape for zero tokens.

Every run writes a journal, manifest, result and script under
`<data>/opencode/tool-output/ultraopen/<runId>/`. Read `journal.jsonl` before diagnosing an
unexpected result: it records each agent's actual return value, and marks replayed entries so a
cached empty is distinguishable from a fresh one.

Pass `resumeFromRunId` to replay a previous run. Unchanged calls return instantly; the first edited
call and everything after it in the same scope runs live.

## Gotchas

- `meta` is a pure literal — no variables, calls, spreads or template strings.
- `parallel()` takes **thunks**, not promises.
- `.filter(Boolean)` every `parallel`/`pipeline` result — `null` means an agent produced nothing.
- A pipeline stage that RETURNS `null` drops that item and skips its remaining stages.
- Guard budget loops on `budget.total`, or with no target set `remaining()` is `Infinity` and the
  loop runs to the agent cap.
- Don't ask a subagent for prose — its final text IS the return value.
