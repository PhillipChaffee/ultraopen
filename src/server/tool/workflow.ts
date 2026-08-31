import { WorkflowScriptError, render } from "../script/errors.js"
import { parse } from "../script/parse.js"
import { run as runSandbox } from "../script/sandbox.js"
import { parallel, pipeline } from "../runtime/combinators.js"
import { Run, type AgentOptions, type ProgressEvent } from "../runtime/run.js"
import { subagentContract } from "../bridge/contract.js"
import { makeResolvers } from "../bridge/models.js"
import { registry } from "../singleton.js"
import type { Ruleset } from "../bridge/permission.js"
import type { OpencodeClient } from "../types.js"

export type WorkflowArgs = {
  script?: string
  scriptPath?: string
  name?: string
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

export type WorkflowContext = {
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
  /** Reads a persisted script for `scriptPath`. Injected so the engine stays filesystem-free. */
  readScript?: ((path: string) => Promise<string>) | undefined
}

export type WorkflowResult = {
  runId: string
  meta: { name: string; description: string }
  value: unknown
  agentCount: number
  nulls: Array<{ label: string; reason: string; detail: string }>
  logs: string[]
  outputTokens: number
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

export type PreparedWorkflow = { source: string; meta: ReturnType<typeof parse>["meta"]; body: string }

/**
 * Resolves and parses the script WITHOUT running it.
 *
 * Split out so the permission prompt can name the real workflow and describe what it will do.
 * Parsing is pure and cheap, and `meta` is a pure literal precisely so it can be read before any
 * code executes — which is exactly this use case.
 */
export async function prepare(args: WorkflowArgs, context: WorkflowContext): Promise<PreparedWorkflow> {
  assertNotNested(context.sessionID)
  const source = await resolveSource(args, context)
  const parsed = parse(source)
  return { source, meta: parsed.meta, body: parsed.body }
}

async function runPrepared(
  prepared: PreparedWorkflow,
  args: WorkflowArgs,
  context: WorkflowContext,
): Promise<WorkflowResult> {
  const parsed = prepared

  // Notes can arrive both before the Run exists (catalog fetch) and during the script
  // (per-model downgrades, emitted lazily when an agent first asks for an effort). Buffer until
  // the Run is available, then redirect straight to its log — draining once up front would
  // silently discard every note raised after the script starts, which is most of them.
  const sink: { emit?: (note: string) => void } = {}
  const buffered: string[] = []
  const note = (message: string): void => {
    if (sink.emit) sink.emit(message)
    else buffered.push(message)
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
    ...optional("resolveModel", resolvers.resolveModel),
    ...optional("resolveVariant", resolvers.resolveVariant),
    ...optional("inheritedPermission", context.inheritedPermission),
    ...optional("deadlineMs", context.deadlineMs),
    ...optional("signal", context.signal),
    ...optional("onProgress", context.onProgress),
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
  for (const message of buffered) run.log(message)

  try {
    const value = await runSandbox(prepared.body, {
      agent,
      parallel,
      pipeline,
      phase: run.phase,
      log: run.log,
      args: args.args,
      budget: budgetStub(run),
      workflow: nestedStub,
    })

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
    }
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
  if (!registry.owns(sessionID)) return
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
  if (args.script) return args.script
  throw new WorkflowScriptError({
    kind: "RuntimeError",
    message: "A workflow needs a `script`, a `scriptPath`, or a saved `name`.",
    suggestions: ["Pass the script inline via `script` on the first run."],
  })
}

/**
 * `budget` for M1.
 *
 * Reports real spend so `budget.spent()` is already meaningful, but carries no ceiling — the
 * enforcing form arrives with the rest of the budget work. `total: null` is the spec's own
 * "no target set" signal, and every documented loop guards on it.
 */
function budgetStub(run: Run): { total: null; spent: () => number; remaining: () => number } {
  return {
    total: null,
    spent: () => run.outputTokens,
    remaining: () => Number.POSITIVE_INFINITY,
  }
}

/** Nested workflows arrive later; per the spec these THROW rather than returning null. */
function nestedStub(): never {
  throw new WorkflowScriptError({
    kind: "RuntimeError",
    message: "Nested workflow() is not available yet in this build.",
    suggestions: ["Run the phases as separate top-level workflow calls for now."],
  })
}

function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** Renders a failure for the model, with the caret line when the script is available. */
export function renderFailure(error: unknown, source?: string): string {
  if (error instanceof WorkflowScriptError) return render(error.diagnostic, source)
  return error instanceof Error ? error.message : String(error)
}
