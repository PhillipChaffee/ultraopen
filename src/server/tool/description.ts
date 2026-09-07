/**
 * The `workflow` tool description.
 *
 * Behaviourally load-bearing prompt text, not documentation: the opt-in gate and the
 * pipeline-vs-parallel decision rule are what make the model write correct scripts.
 *
 * Adapted from Claude Code's Workflow tool. Differences from the original are deliberate and
 * limited to what opencode actually does — see NOTICE:
 *   - `Workflow({...})` -> `workflow({...})`, the opencode tool id
 *   - "the Agent tool" -> "the task tool"
 *   - the async task-id contract is rewritten as blocking, because opencode exposes no
 *     background-job route to a plugin
 */
export const description = `Execute a workflow script that orchestrates multiple subagents deterministically.

A workflow is a deterministic JavaScript driver in which agent() is the only nondeterministic call.
Control flow — loops, fan-out, dedup, thresholds, early exit, synthesis — is real code that you
write. Only the LLM steps vary between runs. That property is what buys the three things workflows
are for: comprehensiveness (decompose and cover in parallel), confidence (independent perspectives
and adversarial checks before committing), and scale (work one context window cannot hold).

This call BLOCKS until the run completes, then returns one consolidated result. A 15-agent run can
take many minutes. That matches the intended rhythm anyway: scout inline first to discover the
work-list, then fan out over it, and read each result before deciding the next phase.

## When to use it

Reach for a workflow when the work decomposes into many independent pieces, when a finding needs
verifying from more than one angle, or when the search space is too large for one context. For a
single-file change or a question you can answer directly, do it yourself — a workflow costs many
model calls.

## Writing a script

Every script begins with a pure-literal meta, then the body runs in an async context:

    export const meta = {
      name: 'review-changes',
      description: 'Review changed files across dimensions, verify each finding',
      phases: [{ title: 'Review' }, { title: 'Verify' }],
    }
    const DIMENSIONS = [{key: 'bugs', prompt: '...'}, {key: 'perf', prompt: '...'}]
    const results = await pipeline(
      DIMENSIONS,
      d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS}),
      review => parallel(review.findings.map(f => () =>
        agent(\`Adversarially verify: \${f.title}\`, {phase: 'Verify', schema: VERDICT})
          .then(v => ({...f, verdict: v}))
      ))
    )
    return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }

meta must be a PURE LITERAL — no variables, calls, spreads or template interpolation. It is read
statically, before the script runs.

## Available globals

- agent(prompt, opts?) — spawn a subagent. Without a schema it returns the agent's final text;
  with one (a JSON Schema) it returns the validated object. Returns null if the agent produced
  nothing usable, so always .filter(Boolean) before consuming results.
  opts: {label, phase, schema, model, effort, agentType, disallowedTools}
- pipeline(items, ...stages) — each item flows through every stage independently, with NO barrier
  between stages. Item A can be in stage 3 while item B is still in stage 1. Stage callbacks get
  (prevResult, originalItem, index). An item drops to null if a stage throws or returns null.
- parallel(thunks) — a BARRIER: takes an array of FUNCTIONS (() => agent(...)), not promises, and
  waits for all of them. A failing thunk becomes null; the call itself never rejects.
- phase(title), log(message) — progress narration.
- args — the value you passed as \`args\`, verbatim.
- budget — {total, spent(), remaining()}.

DEFAULT TO pipeline(). Only use a parallel() barrier when a stage genuinely needs ALL of the
previous stage's results together — to dedup across the whole set, to early-exit on zero findings,
or to compare findings against each other. "I need to flatten or filter first" is NOT a reason:
do that inside a pipeline stage. Barrier latency is real — if five finders run and the slowest
takes three times the fastest, a barrier wastes the fast ones' idle time.

## Rules the engine enforces

- Plain JavaScript only. Type annotations, interfaces and generics fail to parse.
- Date.now(), Math.random() and argless new Date() are rejected — they break resume. Pass
  timestamps via args, and vary behaviour by index rather than randomly.
- No imports, no filesystem, no Node globals. Delegate that work to an agent().
- Limits: 1000 agents per run, 4096 items per parallel/pipeline call, 524288 characters of script.
  Exceeding one is an explicit error, never a silent truncation.

## Patterns worth composing

- Adversarial verify: spawn several independent skeptics per finding, each asked to REFUTE it.
  Kill the finding if a majority refute. Stops plausible-but-wrong findings surviving.
- Perspective-diverse verify: when something can fail in more than one way, give each verifier a
  distinct lens (correctness, security, performance, does-it-reproduce) instead of N identical ones.
- Judge panel: generate N independent attempts from different angles, score them with parallel
  judges, then synthesize from the winner while grafting the best ideas from the runners-up.
- Loop-until-dry: for unknown-size discovery, keep spawning finders until K consecutive rounds
  return nothing new. Dedup against everything SEEN, not everything confirmed, or rejected findings
  resurface forever and the loop never terminates.
- Multi-modal sweep: parallel agents each searching a different way, since one angle rarely finds
  everything.
- Completeness critic: a final agent asking "what is missing — which angle was not run, which
  claim is unverified?" What it finds becomes the next round.

Scale to what was asked. "Find any bugs" warrants a few finders and a single verification pass;
"audit this thoroughly" warrants a larger pool, several verification votes and a synthesis stage.

Pass dryRun: true to run the whole script with agent() stubbed out — it exercises parsing, control
flow and fan-out shape for zero tokens, which is the cheapest way to debug a script.`
