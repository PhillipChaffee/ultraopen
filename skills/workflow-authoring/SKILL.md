---
name: workflow-authoring
description: Use when authoring, editing, or debugging an ultraopen workflow script for the `workflow` tool — writing a new multi-agent script, choosing pipeline vs parallel, bounding a fan-out or discovery loop, handling null agent results, defining a JSON schema, or diagnosing a dry-run, journal, resume, or budget failure.
---

# Authoring a workflow script

A workflow is deterministic JavaScript. `agent()` is the only call whose result can change between
runs; fan-out, loops, dedup, thresholds, early exit and synthesis are ordinary code. That is what
makes a run reproducible and resumable.

Aim for one screen. The engine already enforces the agent cap, budget ceiling, args transport and
schema validation; re-implementing those in the script adds lines and can turn a loud failure into
a silent one.

## A complete script

```javascript
export const meta = {
  name: 'review-files',
  description: 'Review files across dimensions, refute every finding, return survivors',
  phases: [{ title: 'Find' }, { title: 'Verify' }],
}

const files = args.files
const dimensions = args.dimensions ?? ['correctness', 'security', 'performance']

const FINDINGS = {
  type: 'object', required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['file', 'title', 'evidence'],
        properties: { file: { type: 'string' }, title: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
  },
}

const VERDICT = {
  type: 'object', required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const refute = (finding, lens) =>
  agent(`Try to REFUTE this finding. ${lens}\n\n${JSON.stringify(finding)}`, {
    phase: 'Verify',
    schema: VERDICT,
  }).then((verdict) => (verdict?.refuted === false ? finding : null))

const reviewed = await pipeline(
  files.flatMap((file) => dimensions.map((dimension) => ({ file, dimension }))),
  ({ file, dimension }) =>
    agent(`Find ${dimension} defects in ${file}. Quote file and line evidence.`, {
      label: `find:${file}:${dimension}`,
      phase: 'Find',
      schema: FINDINGS,
    }),
  async (review) => {
    const findings = review?.findings ?? []
    return await pipeline(
      findings,
      (finding) => refute(finding, 'Does the quoted evidence actually reproduce the defect?'),
      (finding) => refute(finding, 'Is the defect in scope for this file and change?'),
    )
  },
)

return { findings: reviewed.flat().filter(Boolean), spent: budget.spent() }
```

The inner `pipeline` short-circuits: a refuted finding becomes `null`, so its remaining skeptic
never runs.

## API

| Global | Contract |
|---|---|
| `agent(prompt, opts?)` | Returns final text, or the validated object when `schema` is set. Returns `null` when the agent produced nothing usable, and may return `undefined` for empty text, so `.filter(Boolean)`. Agent-level failures return `null`; script-argument errors (empty prompt, unsatisfiable schema) and engine limits throw. |
| `pipeline(items, ...stages)` | No barrier: each item flows through every stage independently. A stage gets `(prev, originalItem, index)`. A stage that throws an ordinary error, or returns `null`/`undefined`, drops that item; engine faults throw and fail the run. |
| `parallel(thunks)` | A barrier over an array of functions: `parallel([() => agent(...)])`, never promises. An ordinary thunk failure becomes `null`; engine faults throw. |
| `phase(title)`, `log(message)` | Progress narration only. |
| `args` | The caller's value. A stringified JSON object or array is hydrated at the boundary (loudly); a JSON-looking string that does not parse is refused. Omit it for no arguments: `""`, `"null"` and `"undefined"` are refused as decorations. A script that reads `args.X`, destructures `args`, or reads through an alias needs a real object at launch; a scalar or absent `args` throws at script start with zero agents spawned. |
| `budget` | `{ total, spent(), remaining() }` in output tokens. `total` is `null` when uncapped and `remaining()` is then `Infinity`. The ceiling is hard: the next `agent()` call throws when spend reaches it. Nested runs share the launch family's ledger. |
| `workflow(ref, args?)` | Runs a saved name or `{ script }` inline. One nesting level only. Throws on failure, unlike `agent()`, and bad references throw synchronously. Shares the launch's concurrency gate, budget family, abort signal and dry-run state; each run has its own 1,000-agent cap. |

`agent()` opts: `label`, `phase`, `schema`, `model`, `effort`, `agentType`, `disallowedTools`,
`isolation`.

- `schema` is a JSON Schema; invalid output retries up to three attempts in the same session, and
  an unsatisfiable schema throws before the session exists.
- `model` is `"provider/model"`; an unsupported `effort` downgrades to the strongest supported
  level at or below the request and logs a note.
- `label` names the agent in progress, journal and child-session title; `phase` defaults to the
  last `phase()` call. `agentType` selects an opencode agent type; `disallowedTools` hides tools.
- `isolation: "worktree"` runs the agent in its own detached git worktree under the host's
  canonical project root; it is ignored with a log note when that root is not a git repository.

## Rules the engine enforces

- **`meta` first and pure.** `export const meta = { ... }` must be the first statement and a pure
  literal: no variables, calls, spreads, computed keys, regular expressions or template
  interpolation. `name` and `description` are required. `phases[].detail` and `phases[].model` are
  display-only, and `model` does not override the agent model.
- **Plain JavaScript.** No type annotations, interfaces or generics.
- **Deterministic.** `Date.now()`, `Math.random()` and argless `new Date()` are rejected. Pass
  timestamps via `args`; vary behaviour by index. `new Date(args.now)` and `Date.parse` are fine.
- **No host access.** No imports, filesystem, network or Node globals. `require`, `process`,
  `fetch`, `Bun`, `global`, `globalThis`, `self`, `eval` and `Function` are rejected, and
  `.constructor` access is banned. Every identifier must resolve: a typo or undeclared constant is
  refused before the run starts.
- **Strict mode.** Writes to undeclared names throw at runtime.
- **Limits.** 1,000 agents per run, 4,096 items per `parallel`/`pipeline` call, 524,288 characters
  of script. Exceeding one is an explicit error, never silent truncation.

## Control flow

**Default to `pipeline`.** It streams each item through the stages with no barrier, so wall-clock
is the slowest item chain, not the sum of per-stage maxima. Use a `parallel` barrier only when a
stage needs ALL of the previous stage's results together: dedup across the whole set, early-exit on
zero findings, or pairwise comparison. "I need to flatten or filter first" is not a reason; do it
inside a pipeline stage.

**Bound loops on data, not on a clock.** A discovery loop needs a round cap, a dry-streak stop and
a budget guard. Dedup on a stable key against everything seen, not only confirmed findings, or
rejected findings resurface forever:

```javascript
const seen = new Set()
const confirmed = []
const keyOf = (f) => `${f.file}:${f.line}:${f.title}` // stable key, not object identity
const headroom = budget.total === null ? 0 : Math.min(50_000, Math.ceil(budget.total * 0.2))
let dryStreak = 0
let rounds = 0
const maxRounds = args.rounds ?? 3

while (dryStreak < 2 && rounds < maxRounds) {
  // Always run one round; a fixed reserve can starve a small ceiling.
  if (rounds > 0 && budget.total !== null && budget.remaining() < headroom) break
  rounds++
  const found = await agent(`Round ${rounds}. New issues only: ${[...seen].join(', ')}`, {
    phase: `Round ${rounds}`,
    schema: FINDINGS, // schema with a findings array
  })
  const fresh = (found?.findings ?? []).filter((f) => !seen.has(keyOf(f)))
  fresh.forEach((f) => { seen.add(keyOf(f)); confirmed.push(f) })
  dryStreak = fresh.length === 0 ? dryStreak + 1 : 0
}
return { confirmed, rounds, spent: budget.spent() }
```

Without `budget.total !== null`, an uncapped run has `remaining() === Infinity`, the guard never
fires, and the loop runs to the 1,000-agent backstop. A guard checked before the first round can
also stop a run with a small ceiling before it does any work.

**Never swallow an engine limit.** The budget ceiling, the agent cap and an abort throw on purpose.
Wrapping `agent()` in a guard that returns `null` for those conditions makes partial coverage look
complete. Put bounds in the loop condition and let the engine fail loudly if they are wrong.

## Patterns

- **Adversarial verify** — independent skeptics per finding, each asked to REFUTE it with a
  schema. Require every skeptic to return `refuted: false`, and treat a `null` verdict as a
  refutation: a failed skeptic must never let a finding survive.
- **Perspective-diverse verify** — give each skeptic a distinct lens (does it reproduce, is it in
  scope, is it security-relevant) instead of N identical prompts.
- **Judge panel** — generate N attempts from different angles, score them with parallel judges,
  then synthesize from the winner while grafting the best ideas from the runners-up.
- **Synthesize only what survived.** Feed the synthesis agent the verified survivors, not the raw
  findings, and return early when there are none: an empty report invites invention and wastes a
  call.
- **Completeness critic** — a final agent asking "what is missing: which angle was not run, which
  claim is unverified?" Feed what it finds into the next round.
- **Scale to the ask** — "find any bugs" warrants a few finders and one verification pass; "audit
  this thoroughly" warrants a larger pool, several votes and a synthesis stage.

## Pre-flight and debugging

**Dry run first.** Launch with `dryRun: true`: the whole script runs with `agent()` stubbed, zero
tokens, and catches parse errors, meta violations, determinism and undefined-name lint, the `args`
gate, combinator signatures, contradictory schemas, and empty or non-string agent prompts.

**Know what a dry run cannot see.** The stub returns `[dryRun] <prompt>` for a plain agent and
`{}` for a schema agent. A stage that reads a schema field therefore sees `undefined`:
`review.findings.map(...)` throws, and `pipeline`/`parallel` turn that into a dropped item or a
`null` vote. A broken verify stage can pass a dry run because it never receives a finding. Make
stages null-tolerant (`review?.findings ?? []`) and smoke-test one real item before trusting the
full fan-out. Prompt quality, schema fit under real providers and budget behaviour are only
visible live.

**Read the journal before theorizing.** Every run writes `journal.jsonl`, `manifest.json`,
`result.json` (or `failure.txt`), `script.js` and per-agent recordings under
`<data>/opencode/tool-output/ultraopen/<runId>/`. The journal records each agent's actual return
value, its failure reason, and whether it replayed. A cached empty and a fresh empty look identical
without it.

**Resume with `resumeFromRunId`.** Unchanged calls replay instantly; the first edited call and
everything after it in the same scope runs live. Changing `args` invalidates everything, because
args are part of the replay seed. A failed run keeps its partial journal.

## Launching

The tool launches background by default: the call returns a run handle at once and the outcome
arrives later as a `<workflow-completed>` or `<workflow-failed>` notification. Until it arrives,
the handle says nothing about results. Do not poll or duplicate the run's work; call
`workflow_status` only when the user asks about the run or the task cannot finish without its
value, and pass `wait` so one call blocks. In a one-shot host (`opencode run`) hold the turn by
polling until the run settles. A background run continues after the turn, so aborting the call
does not stop it: use `workflow({ stop: "<runId>" })`, or `/workflow-stop <runId>` in the TUI. Do
not relaunch because a status says "running".

## Common mistakes

| Mistake | Fix |
|---|---|
| `parallel([agent(...), agent(...)])` | Pass thunks: `parallel([() => agent(...)])`. Promises start immediately and are refused. |
| Consuming results without `.filter(Boolean)` | Every agent call can contribute `null` or `undefined`. |
| A pipeline stage returns nothing on a branch | `undefined` drops the item. Return a value or `null` deliberately. |
| Loop guarded only on `budget.remaining()` | Guard `budget.total !== null` first, or the loop runs to the agent cap. Run the first round before the guard, and scale the headroom to the ceiling. |
| A fixed completion reserve checked before round one | A 5k ceiling never starts. Run one round first and size the reserve as a fraction of `budget.total`. |
| Dedup by object identity, or only confirmed findings | Use a stable key and add every finding to `seen`, including rejected ones. |
| A null verdict treated as a pass | Treat a failed skeptic as a refutation; otherwise a null vote protects a bad finding. |
| `args.foo` with no `args` | Pass a real object, or make the script tolerate absent args. |
| Asking an agent for prose, then parsing it | Use `schema` for anything you will index into. |
| Trusting a dry run of a schema-driven verify stage | The stub returns `{}`; smoke-test one live item. |
| Your own agent cap returning `null` | Let the engine's limit throw; a silent cap hides a runaway loop. |
| Running the synthesis agent with zero survivors | Return early; an empty report invites invention and wastes a call. |
| A nested `workflow('dir/name')` | Names are bare lookup keys; a path separator is refused. |
| Expecting `isolation: "worktree"` outside a git repository | It is ignored with a log note; the agent runs normally in the project root. |
