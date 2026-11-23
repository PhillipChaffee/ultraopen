import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolveLaunchContract } from "../options.js"
import type { UltraopenOptions } from "../options.js"
import { execute, prepare, projectLaunchSize, renderFailure, WorkflowRunError } from "./workflow.js"
import { launchMetadataOf } from "./args-transport.js"
import type { PreparedWorkflow, WorkflowArgs } from "./workflow.js"
import { nameRun, siblingRunsForSession, dropPending, dropSettled } from "./background.js"
import { renderResult, renderLaunch, renderStopFailure, stopReasonOf } from "./render.js"
import { scanNamedWorkflows } from "./named.js"
import type { SavedWorkflow } from "./named.js"
import { wireRun, startDetachedRun } from "./settlement.js"
import type { SettleOutcome } from "./settlement.js"
import { beginRun, loadResume } from "../resume/persist.js"
import type { ResumeSource } from "../resume/persist.js"
import { ensureRunDir, readManifest, removeRunDir, writeScript } from "../resume/store.js"
import type { Manifest } from "../resume/journal.js"
import type { HostPort } from "../host/port.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import {
  checkResumeGate,
  defaultModelOf,
  gateSession,
  LaunchPermissionDenialError,
  nativeAncestorSessionIDs,
  refreshCommandSurface,
  requestLaunchPermission,
  stopWorkflow,
  validateLaunchBoundary,
} from "./launch-gate.js"
import type { AssertLaunchPermission } from "./launch-gate.js"
import { optional } from "../runtime/run.js"

/** The permission ask's public surface, owned by the gate and re-exported for the composition root. */
export type { AssertLaunchPermission, LaunchPermissionInput } from "./launch-gate.js"

/**
 * The `workflow` tool's launch contract, extracted from the plugin entrypoint.
 *
 * Two contracts share this path. `background` — the default — returns the run id at once and hands
 * the run to a detached task, so the session stays free while the run works; `blocking` waits for
 * the final result, for one-shot hosts that kill the process after the turn. `dryRun` always
 * blocks: it is free, finishes in milliseconds, and its whole point is the fan-out preview inside
 * the result.
 *
 * The permission ask is V2's `ctx.permission.assert`. A rejection there is a STEP-LEVEL signal, not
 * tool output: it is rethrown after the pending entry and the pre-ask run directory are cleaned up,
 * so the model sees a denied call and OpenCode cancels the step correctly.
 */

/** One saved workflow as the command surface names it. */
export type { SavedWorkflow } from "./named.js"

/** The launch's recorded lineage, owned by the gate and re-exported for its consumers. */
export { MAX_ANCESTOR_DEPTH, nativeAncestorSessionIDs } from "./launch-gate.js"

/** Mutable command-surface state shared with the transform that registers `/workflow-<name>`. */
export interface WorkflowCommandState {
  entries: SavedWorkflow[]
  readonly reload: () => void
}

/** Everything the launch needs from the composition root. */
export interface LaunchDeps {
  /** The reloadable host proxy: settlement and stops read the current activation's host. */
  readonly host: HostPort
  readonly project: ProjectRuntime
  readonly coordinator: RuntimeCoordinator
  readonly options: UltraopenOptions
  readonly bootId: string
  readonly longLived: boolean
  readonly commandState: WorkflowCommandState
  readonly assertPermission: AssertLaunchPermission
}

/** The tool-execute context fields the launch reads. */
export interface LaunchContext {
  readonly sessionID: string
  readonly agent?: string | undefined
  /** The tool call's cooperative-stop signal. */
  readonly signal?: AbortSignal | undefined
}

/** A tool call that reached the launch from inside a subagent. */
const SUBAGENT_REFUSAL = [
  "<workflow-refused>",
  "The workflow tool is available only to primary agents; a subagent cannot start its own workflow.",
  "Return your findings and let the primary agent decide what to run next.",
  "</workflow-refused>",
].join("\n")

/**
 * Launches one workflow run.
 *
 * The stop path short-circuits BEFORE the launch boundary: a session with a live run must be able
 * to stop it. Everything after the stop dispatch is a launch.
 */
export async function launchWorkflow(
  args: WorkflowArgs,
  context: LaunchContext,
  deps: LaunchDeps,
): Promise<string> {
  // A subagent must never start a fan-out: it is already one, and the recursion guard's
  // permission/ruleset layers can be bypassed by a forked session or a config edit.
  if (context.agent !== undefined) {
    const agent = await deps.host.getAgent(context.agent)
    if (agent?.mode === "subagent") {return SUBAGENT_REFUSAL}
  }

  // An EMPTY stop value is a launch default, not a stop request — models emit optional fields as "".
  if (args.stop !== undefined && args.stop !== "") {return await stopWorkflow(args.stop, deps)}

  // Zero-value decoration weather and the stringified-JSON transport are refused at the boundary,
  // never normalized, always after the stop dispatch and before the launch gate and permission ask.
  const boundaryRefusal = validateLaunchBoundary(args)
  if (boundaryRefusal !== undefined) {return boundaryRefusal}

  const background = args.dryRun !== true &&
      resolveLaunchContract(args.background, deps.options) === "background",
    runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    launchMetadata = launchMetadataOf(args),
    defaultModel = await defaultModelOf(deps.host),
    scanNotes: string[] = [],
    // Saved workflows resolve from disk on every call: a file saved mid-session runs by name at
    // once, and no cached map can drift from what is on disk.
    named = await scanNamedWorkflows({
      workflowPaths: deps.options.workflowPaths,
      directory: deps.host.location.directory,
      canonicalDirectory: deps.host.location.canonical,
      onNote: (note) => scanNotes.push(note),
    })

  // A live rescan whose names or sources changed refreshes the `/workflow-<name>` command surface
  // on the next command reload; the RUN path itself never waits for that reload.
  refreshCommandSurface(named, deps.commandState)

  const gated = gateSession(args, context, deps, runId)
  if (gated !== undefined) {return gated}

  const scanNoteLines = scanNotes.length > 0 ? ["", "<scan-notes>", ...scanNotes, "</scan-notes>"] : []

  try {
    // The live native chain above this session, nearest first. Recorded on every child so
    // `onV2Event` can revoke a stale pending permission when a grandparent tightens its agent.
    const ancestorSessionIDs = await nativeAncestorSessionIDs(deps.host, context.sessionID)

    const refusedResume = await checkResumeGate(args, context.sessionID, deps.coordinator)
    if (refusedResume !== undefined) {
      dropPending(deps.coordinator, runId)
      return refusedResume
    }

    const prepared = await prepare(args, {
      host: deps.host,
      project: deps.project,
      coordinator: deps.coordinator,
      sessionID: context.sessionID,
      runId,
      ancestorSessionIDs,
      readScript: readScriptOf,
      worktreeRoot: deps.host.location.canonical,
    })

    // The per-turn live-run reminder names the workflow, and prepare() is where the name is first
    // known — recorded before the ask so even a pending entry carries it.
    nameRun(deps.coordinator, runId, prepared.meta.name, launchMetadata.title)

    // Persist the script BEFORE the ask, so the user can open the real file while the prompt is on
    // screen. Best-effort: a failed write must not block the prompt.
    await ensureRunDir(runId).catch(() => undefined)
    await writeScript(runId, prepared.source).catch(() => undefined)

    const projectedAgents = args.dryRun === true
      ? undefined
      : await projectLaunchSize(prepared, named, optional("signal", context.signal))

    await requestLaunchPermission({
      runId,
      context,
      deps,
      prepared,
      background,
      dryRun: args.dryRun === true,
      projectedAgents,
    })

    // Resume BEFORE the run starts, so replayed calls never spawn anything.
    const resume = args.resumeFromRunId
      ? await loadResume(args.resumeFromRunId, prepared.argsValue, context.sessionID)
      : undefined

    const run: LaunchRun = {
      args,
      runId,
      context,
      deps,
      prepared,
      named,
      scanNoteLines,
      ancestorSessionIDs,
      resume,
      defaultModel,
      projectedAgents,
      launchMetadata,
      background,
    }
    return args.dryRun === true ? await runDry(run) : await launchLive(run)
  } catch (error) {
    // A denied ask is a step-level signal, never tool output. It already cleaned up after itself.
    if (error instanceof LaunchPermissionDenialError) {throw error.denial}
    dropPending(deps.coordinator, runId)
    // The run id/dir footer renders only when the run went live (#133): the disk is the arbiter.
    const wentLive = (await readManifest(runId)) !== undefined
    if (!wentLive) {await removeRunDir(runId)}
    return renderFailure(error, args.script, wentLive ? runId : undefined)
  }
}

/** Everything a resolved launch hands to its dry or live contract. */
interface LaunchRun {
  readonly args: WorkflowArgs
  readonly runId: string
  readonly context: LaunchContext
  readonly deps: LaunchDeps
  readonly prepared: PreparedWorkflow
  readonly named: Record<string, string>
  readonly scanNoteLines: readonly string[]
  readonly ancestorSessionIDs: readonly string[]
  readonly resume: ResumeSource | undefined
  readonly defaultModel: string | undefined
  readonly projectedAgents: number | undefined
  readonly launchMetadata: ReturnType<typeof launchMetadataOf>
  readonly background: boolean
}

/** Reads a persisted script for `scriptPath`; injected so the engine stays filesystem-free. */
const readScriptOf = async (path: string): Promise<string> => await readFile(path, "utf8")

/** The dry contract: exercise the whole engine for zero tokens, then remove the pre-ask dir. */
async function runDry(run: LaunchRun): Promise<string> {
  const { args, runId, context, deps, named, resume, ancestorSessionIDs, defaultModel } = run
  const result = await execute(args, {
    host: deps.host,
    project: deps.project,
    coordinator: deps.coordinator,
    sessionID: context.sessionID,
    runId,
    ancestorSessionIDs,
    deadlineMs: deps.options.agentDeadlineMs,
    idleMs: deps.options.agentIdleMs,
    readScript: readScriptOf,
    ...optional("defaultModel", defaultModel),
    ...optional("budgetTotal", deps.options.budgetTokens ?? undefined),
    ...optional("signal", context.signal),
    worktreeRoot: deps.host.location.canonical,
    ...(Object.keys(named).length > 0 ? { named } : {}),
    ...(resume !== undefined && resume.entries.length > 0
      ? { previousEntries: resume.entries, ...optional("resumedFrom", args.resumeFromRunId) }
      : {}),
  })
  await removeRunDir(runId)
  return [renderResult(result, {
    resumed: resume?.entries.length ?? 0,
    argsChanged: resume?.argsChanged === true,
  }, siblingRunsForSession(deps.coordinator, context.sessionID, runId), deps.options.budgetTokens, { dry: true }), ...run.scanNoteLines].join("\n")
}

/** The live contract: persist the manifest, then either wait for the run or detach it. */
async function launchLive(run: LaunchRun): Promise<string> {
  const { args, runId, context, deps, prepared, named, resume, ancestorSessionIDs } = run,
   { defaultModel, projectedAgents, launchMetadata } = run
  // The manifest MUST be on disk before this call returns: the launch result names a run id
  // that `workflow_status` has to resolve.
  const manifest = await beginRun({
    runId,
    sessionID: context.sessionID,
    source: prepared.source,
    args: prepared.argsValue,
    bootId: deps.bootId,
    projectID: deps.host.location.projectID,
    directory: deps.host.location.canonical,
    ...optional("argsRawString", prepared.argsHydrated?.raw),
    ...launchMetadata,
  })
  if (!manifest) {
    dropPending(deps.coordinator, runId)
    return "The workflow could not be started: its run directory could not be created. " +
      "Nothing was executed and no tokens were spent."
  }

  const shared = {
    runId,
    host: deps.host, project: deps.project,
    coordinator: deps.coordinator, sessionID: context.sessionID,
    ancestorSessionIDs,
    manifest,
    prepared,
    args,
    options: deps.options,
    named: Object.keys(named).length > 0 ? named : undefined,
    ...optional("defaultModel", defaultModel),
    previousEntries: resume?.entries,
    resumedFrom: args.resumeFromRunId,
    resume: { resumed: resume?.entries.length ?? 0, argsChanged: resume?.argsChanged === true },
    worktreeRoot: deps.host.location.canonical,
  }

  if (!run.background) {
    const wiring = wireRun({ ...shared, ...optional("signal", context.signal) })
    // The stop path marks this run through its own writer while the blocking call is in flight.
    const live = deps.coordinator.runs.get(runId)
    if (live !== undefined) {live.markStopping = wiring.markStopping}
    const result = await runBlocking(args, {
      runId, manifest, resume,
      executeContext: wiring.executeContext,
      settleRun: wiring.settle,
      coordinator: deps.coordinator,
      budgetTokens: deps.options.budgetTokens,
      siblings: siblingRunsForSession(deps.coordinator, context.sessionID, runId),
      ...optional("signal", context.signal),
    })
    return [result, ...run.scanNoteLines].join("\n")
  }

  startDetachedRun(shared)

  const projection = projectedAgents === undefined ? undefined : { agents: projectedAgents, threshold: deps.options.largeWorkflowAgents }
  return [renderLaunch(
    prepared.meta.name,
    runId,
    deps.longLived,
    siblingRunsForSession(deps.coordinator, context.sessionID, runId),
    projection,
    deps.options.budgetTokens,
    launchMetadata.title,
  ), ...run.scanNoteLines].join("\n")
}

/** The shared settle protocol's signature; the ONE settle protocol lives in tool/settlement.ts. */
type SettleRun = (outcome: SettleOutcome) => Promise<void>

interface BlockingRun {
  runId: string
  manifest: Manifest
  resume: ResumeSource | undefined
  executeContext: Parameters<typeof execute>[1]
  settleRun: SettleRun
  /** The process coordinator, so the settled entry can be dropped. */
  coordinator: RuntimeCoordinator
  /** The plugin's per-run ceiling, for the blocking result's budget statement. */
  budgetTokens: number | null
  /** The session's other live runs, named in the blocking result's advisory. */
  siblings: ReturnType<typeof siblingRunsForSession>
  /** The tool call's abort signal, read for the stop-naming failure render (#135). */
  signal?: AbortSignal | undefined
}

/**
 * The blocking contract: wait for the run, then return one consolidated result.
 *
 * Kept behaviorally identical to the pre-async tool — it is the documented kill switch
 * (`runMode: "blocking"` / `ULTRAOPEN_WORKFLOW_SYNC=1`). Its launch registered at the session gate
 * like every other launch; the finally drops that entry only after the settle protocol completed.
 */
async function runBlocking(args: WorkflowArgs, run: BlockingRun): Promise<string> {
  const { runId, resume, executeContext, settleRun, budgetTokens, siblings, coordinator } = run
  try {
    const result = await execute(args, executeContext)
    await settleRun({
      status: "completed",
      entries: result.journal,
      value: result.value,
      childSessionIDs: result.childSessionIDs,
    })
    return renderResult(result, {
      resumed: resume?.entries.length ?? 0,
      argsChanged: resume?.argsChanged === true,
    }, siblings, budgetTokens)
  } catch (error) {
    const partial = error instanceof WorkflowRunError ? error.partial : undefined
    await settleRun({
      status: "failed",
      entries: partial?.journal ?? [],
      value: null,
      childSessionIDs: partial?.childSessionIDs ?? [],
    })
    const stopReason = stopReasonOf(run.signal)
    if (stopReason !== undefined) {return renderStopFailure(stopReason, runId)}
    return renderFailure(error instanceof WorkflowRunError ? error.cause : error, args.script, runId)
  } finally {
    // Settled, whatever the outcome. The drop waits for the settle protocol, so no resume may
    // pass while the manifest is still being closed.
    dropSettled(coordinator, runId)
  }
}
