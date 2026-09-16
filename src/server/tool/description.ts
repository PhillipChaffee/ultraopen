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
 */
export const description = `Execute a workflow script that orchestrates multiple subagents deterministically.

A workflow is a deterministic JavaScript driver in which agent() is the only nondeterministic call.
Control flow — loops, fan-out, dedup, thresholds, early exit, synthesis — is real code that you
write. Only the LLM steps vary between runs. That property is what buys the three things workflows
are for: comprehensiveness (decompose and cover in parallel), confidence (independent perspectives
and adversarial checks before committing), and scale (work one context window cannot hold).

This call RETURNS AT ONCE with the run id. The run continues in the background while you keep
working. Poll \`workflow_status\` with the run id (pass \`wait\` so one call blocks until the run
settles or the wait expires) — do not re-launch the same workflow because a poll said "running".
Aborting this call does not stop the run; if you must stop it, tell the user to end the opencode
process, or wait for it to settle and resume from its run id.

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

/**
 * The `workflow_status` tool description.
 *
 * Same rules as the workflow description: this text trains the polling rhythm.
 * Without the `wait` guidance the model polls in a tight loop or abandons runs
 * that would have settled seconds later.
 */
export const statusDescription = `Read the live state of one workflow run from disk.

Pass the runId from the workflow launch result. Pass wait (seconds, up to 300) to block the call
until the run settles or the wait expires — prefer one long wait over many short polls. The report
carries: status (running, completed, failed, or orphaned), the phase names seen so far, agent
counts (total, running, done, failed), the run's output token total, the last log lines, and, when
the run has settled, the final value (completed) or the failure text (failed, orphaned). A run
whose owning process died reports orphaned with a pointer at resume. This tool is read-only and
never spawns anything.`
