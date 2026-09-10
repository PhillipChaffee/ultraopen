import { WorkflowScriptError, render } from "../script/errors.js"
import { parse } from "../script/parse.js"
import { run as runSandbox } from "../script/sandbox.js"
import { parallel, pipeline } from "../runtime/combinators.js"
import { Run } from "../runtime/run.js"
import type { AgentOptions, ProgressEvent } from "../runtime/run.js"
import { subagentContract } from "../bridge/contract.js"
import { makeResolvers } from "../bridge/models.js"
import { argsHash } from "../resume/key.js"
import { runDir } from "../resume/store.js"
import type { JournalEntry } from "../resume/journal.js"
import { registry } from "../singleton.js"
import type { Ruleset } from "../bridge/permission.js"
import type { OpencodeClient } from "../types.js"

export interface WorkflowArgs {
  script?: string
  scriptPath?: string
  args?: unknown
  resumeFromRunId?: string
  dryRun?: boolean
  /**
   * Accepted and ignored, exactly as the spec specifies. A model trained on Claude Code passes
   * these; rejecting them would surface as a schema validation error instead of the documented
   * silent ignore.
   */
  title?: string
  description?: string
}

export interface WorkflowContext {
  client: OpencodeClient
  sessionID: string
  runId: string
  inheritedPermission?: Ruleset | undefined
  resolveModel?: ((model: string | undefined) => { providerID: string; modelID: string } | undefined) | undefined
  resolveVariant?:
    | ((effort: string | undefined, model?: { providerID: string; modelID: string } | undefined) => string | undefined)
    | undefined
  subagentContract?: ((opts: AgentOptions) => string | undefined) | undefined
  /** The session's default model, used to resolve effort against the right variant set. */
  defaultModel?: string | undefined
  deadlineMs?: number | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((event: ProgressEvent) => void) | undefined
  /** Receives each journal entry as it is recorded; the tool layer flushes it to disk. */
  onJournal?: ((entry: JournalEntry) => void) | undefined
  /** Reads a persisted script for `scriptPath`. Injected so the engine stays filesystem-free. */
  readScript?: ((path: string) => Promise<string>) | undefined
  /** Journal entries from the run being resumed. */
  previousEntries?: readonly JournalEntry[] | undefined
  /** The run id being resumed, recorded on replayed entries. */
  resumedFrom?: string | undefined
  /** Output-token ceiling for the run, or null for none. */
  budgetTotal?: number | null | undefined
  /** Repository root, enabling `isolation: "worktree"`. */
  worktreeRoot?: string | undefined
  /** Depth of nesting. workflow() is one level only, so a child runs at depth 1. */
  depth?: number | undefined
  /** Saved workflows, resolved by name. */
  named?: Record<string, string> | undefined
}

export interface WorkflowResult {
  runId: string
  meta: { name: string; description: string }
  value: unknown
  agentCount: number
  nulls: { label: string; reason: string; detail: string }[]
  logs: string[]
  outputTokens: number
  /** This run's journal, for persistence and for a follow-up resume. */
  journal: JournalEntry[]
  /** Child sessions captured before the run's cleanup aborts and forgets them. */
  childSessionIDs: string[]
}

/**
 * A run that failed mid-flight, carrying what did complete.
 *
 * Without it a failed run would be persisted with an empty journal, destroying the replayable
 * prefix of agents that succeeded before the failure — resume would then redo work it already
 * paid for. The cause is kept intact so failure rendering is unchanged.
 */
export class WorkflowRunError extends Error {
  override readonly cause: unknown
  readonly partial: { journal: JournalEntry[]; childSessionIDs: string[] }

  constructor(cause: unknown, partial: { journal: JournalEntry[]; childSessionIDs: string[] }) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "WorkflowRunError"
    this.cause = cause
    this.partial = partial
  }
}

/**
 * Runs one workflow script end to end.
 *
 * The recursion guard runs FIRST, before anything is parsed or spawned: a workflow child must
 * never be able to start its own fan-out, and the cheapest place to stop that is at the door.
 */
export async function execute(args: WorkflowArgs, context: WorkflowContext): Promise<WorkflowResult> {
  const prepared = await prepare(args, context)
  return await runPrepared(prepared, args, context)
}

export interface PreparedWorkflow { source: string; meta: ReturnType<typeof parse>["meta"]; body: string }

/**
 * Resolves and parses the script WITHOUT running it.
 *
 * Split out so the permission prompt can name the real workflow and describe what it will do.
 * Parsing is pure and cheap, and `meta` is a pure literal precisely so it can be read before any
 * code executes — which is exactly this use case.
 */
export async function prepare(args: WorkflowArgs, context: WorkflowContext): Promise<PreparedWorkflow> {
  assertNotNested(context.sessionID)
  const source = await resolveSource(args, context),
   parsed = parse(source)
  return { source, meta: parsed.meta, body: parsed.body }
}

async function runPrepared(
  prepared: PreparedWorkflow,
  args: WorkflowArgs,
  context: WorkflowContext,
): Promise<WorkflowResult> {
  const parsed = prepared,

  // Notes can arrive both before the Run exists (catalog fetch) and during the script
  // (per-model downgrades, emitted lazily when an agent first asks for an effort). Buffer until
  // the Run is available, then redirect straight to its log — draining once up front would
  // silently discard every note raised after the script starts, which is most of them.
   sink: { emit?: (note: string) => void } = {},
   buffered: string[] = [],
   note = (message: string): void => {
    if (sink.emit) {sink.emit(message)}
    else {buffered.push(message)}
  }

  // Read the provider catalog once per run so `effort` resolves against each model's REAL variant
  // set. Skipped entirely for a dry run, which makes no model calls.
  let resolvers: { resolveModel: WorkflowContext["resolveModel"]; resolveVariant: WorkflowContext["resolveVariant"] } = {
    resolveModel: context.resolveModel,
    resolveVariant: context.resolveVariant,
  }
  if (!args.dryRun && !context.resolveVariant) {
    const built = await makeResolvers(context.client, {
      ...(context.defaultModel === undefined ? {} : { defaultModel: context.defaultModel }),
      onNote: note,
    })
    resolvers = { resolveModel: context.resolveModel ?? built.resolveModel, resolveVariant: built.resolveVariant }
  }

  const run = new Run({
    runId: context.runId,
    client: context.client,
    parentSessionID: context.sessionID,
    // Every workflow subagent is told its output is a return value, not a reply to a person,
    // unless the caller supplied its own contract.
    subagentContract: context.subagentContract ?? subagentContract,
    // Seeded from `args`, NOT the script text. The per-call chain already captures every edit
    // that changes what an agent is asked, and does so incrementally — seeding from the source
    // hash would make ANY edit invalidate the entire run, destroying the longest-unchanged-prefix
    // property that makes resume worth having. `args` is different: it is invisible to the chain
    // but can change every result, so a change there must invalidate everything.
    resumeSeed: argsHash(args.args),
    ...optional("previousEntries", context.previousEntries),
    ...optional("resumedFrom", context.resumedFrom),
    ...optional("budgetTotal", context.budgetTotal),
    ...optional("worktreeRoot", context.worktreeRoot),
    ...optional("resolveModel", resolvers.resolveModel),
    ...optional("resolveVariant", resolvers.resolveVariant),
    ...optional("inheritedPermission", context.inheritedPermission),
    ...optional("deadlineMs", context.deadlineMs),
    ...optional("signal", context.signal),
    ...optional("onProgress", context.onProgress),
    ...optional("onJournal", context.onJournal),
  })

  // dryRun exercises the whole engine — parse, sandbox, combinators, control flow — for zero
  // tokens, which is what makes iterating on a script cheap. It still counts the calls, so the
  // result reports the fan-out the script WOULD have produced.
  let dryRunCount = 0
  const agent = args.dryRun
    ? (prompt: string, options: AgentOptions = {}): Promise<unknown> => {
        dryRunCount++
        run.log(`[dryRun] ${options.label ?? prompt.slice(0, 60)}`)
        return Promise.resolve(options.schema ? {} : `[dryRun] ${prompt.slice(0, 200)}`)
      }
    : run.agent

  // Redirect first, then flush: anything raised while the script runs must land in the log too.
  sink.emit = run.log
  for (const message of buffered) {run.log(message)}

  try {
    // The sandbox runs INSIDE the root resume scope, so every agent() call — including those
    // reached through combinator callbacks — sees a scope and gets a stable key.
    const value = await run.withRootScope(
      async () =>
        await runSandbox(prepared.body, {
          agent,
          parallel,
          pipeline,
          phase: run.phase,
          log: run.log,
          args: args.args,
          budget: run.budget,
          workflow: makeNested(context, run),
        }),
    )

    return {
      runId: context.runId,
      meta: { name: parsed.meta.name, description: parsed.meta.description },
      value,
      agentCount: args.dryRun ? dryRunCount : run.agentCount,
      nulls: run.nulls.map((record) => ({
        label: record.label,
        reason: record.reason ?? "unknown",
        detail: record.detail ?? "",
      })),
      logs: run.logs,
      outputTokens: run.outputTokens,
      journal: run.journal.entries,
      // Evaluated BEFORE the finally block aborts and forgets every child, so the manifest ends
      // up with the real list instead of the empty registry it would read afterwards.
      childSessionIDs: registry.sessionsOf(context.runId),
    }
  } catch (error) {
    // Same reasoning, on the failure path: the partial journal and live sessions must survive
    // the cleanup in finally, or persistence would record a run that accomplished nothing.
    throw new WorkflowRunError(error, {
      journal: run.journal.entries,
      childSessionIDs: registry.sessionsOf(context.runId),
    })
  } finally {
    // Children are never cascaded to by the host, so releasing them is ours to do — otherwise a
    // failed or aborted run leaves subagents running and billing.
    await run.abortAll()
  }
}

/**
 * Refuses to run inside a session this engine created.
 *
 * Layer 2 of the recursion guard. Layer 1 (the child permission ruleset) already hides the tool
 * from the model, so reaching here means something bypassed it — a forked session, which drops the
 * ruleset entirely, or a config edit. Failing loudly is correct.
 */
function assertNotNested(sessionID: string): void {
  if (!registry.owns(sessionID)) {return}
  throw new WorkflowScriptError({
    kind: "RuntimeError",
    message: "workflow() cannot be called from inside a workflow subagent.",
    suggestions: ["Return findings to the parent workflow and let its script decide what to do next."],
  })
}

async function resolveSource(args: WorkflowArgs, context: WorkflowContext): Promise<string> {
  // Precedence is scriptPath > script > name, matching the spec.
  if (args.scriptPath) {
    if (!context.readScript) {
      throw new WorkflowScriptError({
        kind: "RuntimeError",
        message: "scriptPath was supplied but this engine has no script reader configured.",
      })
    }
    return await context.readScript(args.scriptPath)
  }
  if (args.script) {return args.script}
  throw new WorkflowScriptError({
    kind: "RuntimeError",
    message: "A workflow needs a `script` or a `scriptPath`.",
    suggestions: ["Pass the script inline via `script`."],
  })
}

/**
 * Builds the `workflow()` global.
 *
 * Per the spec these failures THROW rather than returning null, unlike `agent()` — a script's
 * try/catch around a nested workflow would otherwise be dead code.
 *
 * The child shares this run's concurrency gate (process-global), agent counter, budget and abort
 * signal, so nesting cannot be used to escape any of them.
 */
function makeNested(
  context: WorkflowContext,
  parentRun: Run,
): (nameOrRef: unknown, childArgs?: unknown) => Promise<unknown> {
  // Deliberately NOT an async function: validation throws SYNCHRONOUSLY, so both
  // `workflow('bad')` and `await workflow('bad')` fail at the call site. An async function would
  // turn every one of these into a rejected promise, and the spec's `catch to handle gracefully`
  // would silently not catch in the un-awaited form.
  return (nameOrRef: unknown, childArgs?: unknown): Promise<unknown> => {
    // One level only. A child that could nest again would make the depth unbounded, and with it
    // the agent count.
    if ((context.depth ?? 0) > 0) {
      throw new WorkflowScriptError({
        kind: "RuntimeError",
        message: "workflow() nesting is one level only — a nested workflow cannot call workflow().",
      })
    }

    const source = resolveNamed(nameOrRef, context)
    return runNested(source, childArgs, context, parentRun)
  }
}

async function runNested(
  source: string,
  childArgs: unknown,
  context: WorkflowContext,
  parentRun: Run,
): Promise<unknown> {
  let child: Awaited<ReturnType<typeof execute>>
  try {
    child = await execute(
      { script: source, args: childArgs },
      {
        ...context,
        depth: (context.depth ?? 0) + 1,
        // The child's spend counts against the parent's ceiling.
        budgetTotal: parentRun.budget.total,
      },
    )
  } catch (error) {
    // The child inherited the parent's onJournal, so its entries were incrementally flushed
    // into the parent's journal FILE. They must also reach the parent's in-memory journal,
    // or the parent's endRun rewrite would erase what the flush wrote — leaving a
    // crash-resume richer than a clean-run resume.
    mergeNestedJournal(error instanceof WorkflowRunError ? error.partial.journal : undefined, parentRun)
    throw error
  }
  mergeNestedJournal(child.journal, parentRun)

  // The spec marks a nested run's agents with a "▸ name" prefix so they are distinguishable in the
  // parent's narration.
  for (const line of child.logs) {parentRun.log(`▸ ${child.meta.name}: ${line}`)}
  return child.value
}

/** Fold the nested run's entries into the parent's journal, preserving record order on disk. */
function mergeNestedJournal(entries: readonly JournalEntry[] | undefined, parentRun: Run): void {
  for (const entry of entries ?? []) {
    parentRun.journal.record(entry)
  }
}

function resolveNamed(nameOrRef: unknown, context: WorkflowContext): string {
  if (typeof nameOrRef === "object" && nameOrRef !== null && "script" in nameOrRef) {
    const {script} = (nameOrRef as { script?: unknown })
    if (typeof script === "string") {return script}
  }
  if (typeof nameOrRef === "string") {
    const found = context.named?.[nameOrRef]
    if (found) {return found}
    throw new WorkflowScriptError({
      kind: "RuntimeError",
      message: `No saved workflow named "${nameOrRef}".`,
      suggestions: ["Pass the script inline instead: workflow({ script: '...' })."],
    })
  }
  throw new WorkflowScriptError({
    kind: "RuntimeError",
    message: "workflow() expects a saved workflow name or { script }.",
  })
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** Renders a failure for the model, with the caret line when the script is available. */
export function renderFailure(error: unknown, source?: string, runId?: string): string {
  let body: string
  if (error instanceof WorkflowScriptError) {
    body = render(error.diagnostic, source)
  } else if (error instanceof Error) {
    body = error.message
  } else {
    body = String(error)
  }
  if (runId === undefined) {return body}
  // A failed run is the main candidate for a resume; naming it makes that recoverable.
  return `${body}\n\n<run id="${runId}" dir="${runDir(runId)}" />`
}
