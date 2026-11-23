import { inspectArgsTransport } from "./args-transport.js"
import {
  dropPending,
  isLiveAnywhere,
  liveRunsForSession,
  registerPending,
  stopRun,
} from "./background.js"
import { WORKFLOW_TOOL } from "../bridge/permission.js"
import { parseSavedWorkflows } from "./named.js"
import type { SavedWorkflow } from "./named.js"
import {
  renderArgsRefusal,
  renderBothSourceRefusal,
  renderCapRefusal,
  renderForeignSessionResumeRefusal,
  renderMissingRunResumeRefusal,
  renderRefusal,
  renderResumeDecorationRefusal,
  renderResumeRefusal,
  renderScriptPathDecorationRefusal,
  renderStringifiedArgsRefusal,
  renderUnrecordedSessionResumeRefusal,
} from "./render.js"
import { isSafeRunId, readManifest, removeRunDir } from "../resume/store.js"
import type { UltraopenOptions } from "../options.js"
import type { HostPort } from "../host/port.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import type { PreparedWorkflow, WorkflowArgs } from "./workflow.js"
import { optional } from "../runtime/run.js"

/**
 * The launch gate: every decision and side effect between a `workflow` tool call and the engine.
 *
 * Boundary refusals, the resume gate, the live-run gate, the permission ask, the stop dispatch,
 * and the lineage a launch records all live here. They share one property — each either refuses
 * the call or runs BEFORE the engine does — which is what keeps a malformed launch free, keeps a
 * denial out of the tool-text channel, and keeps the launch orchestrator down to sequencing.
 */

/** The permission ask's launch-specific input. */
export interface LaunchPermissionInput {
  readonly sessionID: string
  readonly agent?: string | undefined
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[] | undefined
  readonly metadata?: Record<string, unknown> | undefined
}

/** V2's `ctx.permission.assert`, narrowed to the launch's call shape. */
export type AssertLaunchPermission = (input: LaunchPermissionInput) => Promise<void>

/** The tool-context fields the gates read. */
export interface LaunchGateContext {
  readonly sessionID: string
  readonly agent?: string | undefined
}

/** The live-run gate's view of the launch: the state it reads, names, and registers against. */
export interface LaunchGateDeps {
  readonly host: HostPort
  readonly project: ProjectRuntime
  readonly coordinator: RuntimeCoordinator
  readonly options: UltraopenOptions
}

/**
 * Refuses the model-emitted decorations and impossible source pairs (#86, #78, #132, #141, #143).
 *
 * Zero-value decorations (`""`, `"null"`, `"undefined"`) are refused rather than normalized, and a
 * stringified-JSON `args` payload is refused rather than silently re-parsed: both are transport
 * weather the model must learn to stop sending. A script with both `script` and `scriptPath` has
 * no single source, so it is refused before either can be read.
 */
export function validateLaunchBoundary(args: WorkflowArgs): string | undefined {
  if (typeof args.args === "string" && isZeroValueDecoration(args.args)) {
    return renderArgsRefusal(args.args)
  }
  if (typeof args.resumeFromRunId === "string" && isZeroValueDecoration(args.resumeFromRunId)) {
    return renderResumeDecorationRefusal(args.resumeFromRunId)
  }
  if (typeof args.scriptPath === "string" && isZeroValueDecoration(args.scriptPath)) {
    return renderScriptPathDecorationRefusal(args.scriptPath)
  }
  if (args.script && args.scriptPath) {return renderBothSourceRefusal()}

  // Stringified-JSON transport (#78): refused here, before the launch gate and the ask.
  const transport = inspectArgsTransport(args.args)
  return transport.action === "refuse"
    ? renderStringifiedArgsRefusal(transport.raw, transport.reason)
    : undefined
}

/**
 * The resume gate: every refusal that must precede the permission ask.
 *
 * A resume that will be refused is refused BEFORE the ask — a malformed id, a live source run, a
 * foreign session, or a missing run directory. Running it after `ensureRunDir` manufactured a
 * manifest-less directory on every refusal.
 */
export async function checkResumeGate(
  args: WorkflowArgs,
  sessionID: string,
  coordinator: RuntimeCoordinator,
): Promise<string | undefined> {
  if (!args.resumeFromRunId) {return undefined}
  if (!isSafeRunId(args.resumeFromRunId)) {return renderResumeRefusal(args.resumeFromRunId, undefined)}
  const source = await readManifest(args.resumeFromRunId)
  if (!source) {return renderMissingRunResumeRefusal(args.resumeFromRunId)}
  if (isLiveAnywhere(source, coordinator)) {return renderResumeRefusal(source.runId, source.pid)}
  if (typeof source.sessionID !== "string") {return renderUnrecordedSessionResumeRefusal(source.runId)}
  if (source.sessionID !== sessionID) {
    return renderForeignSessionResumeRefusal(source.runId, source.sessionID)
  }
  return undefined
}

/**
 * The live-run gate: one live run per session for non-ultracode sessions, for BOTH contracts;
 * ultracode-active sessions bypass that refusal up to the live-run cap.
 *
 * The check and the pending registration run with NO await between them, so two same-tick calls
 * cannot both pass.
 */
export function gateSession(
  args: WorkflowArgs,
  context: LaunchGateContext,
  deps: LaunchGateDeps,
  runId: string,
): string | undefined {
  if (args.dryRun === true) {return undefined}
  const live = liveRunsForSession(deps.coordinator, context.sessionID)
  if (deps.project.mode.isActive(context.sessionID, context.agent)) {
    if (live.length >= deps.options.ultracodeMaxRuns) {
      return renderCapRefusal(live, deps.options.ultracodeMaxRuns)
    }
  } else {
    const [oldest] = live
    if (oldest) {return renderRefusal(oldest)}
  }
  registerPending(deps.coordinator, {
    runId,
    sessionID: context.sessionID,
    projectKey: deps.project.projectKey,
    locationDir: deps.host.location.directory,
  })
  return undefined
}

/** A permission ask's inputs, gathered so the ask and its single cleanup stay one unit. */
export interface PermissionRequest {
  readonly runId: string
  readonly context: LaunchGateContext
  readonly deps: PermissionDeps
  readonly prepared: PreparedWorkflow
  readonly background: boolean
  readonly dryRun: boolean
  readonly projectedAgents: number | undefined
}

/** The permission ask's view of the launch dependencies. */
export interface PermissionDeps {
  readonly coordinator: RuntimeCoordinator
  readonly options: Pick<UltraopenOptions, "largeWorkflowAgents">
  readonly assertPermission: AssertLaunchPermission
}

/**
 * Asks for the launch permission, and is the ONLY place a denial's cleanup happens.
 *
 * A rejection is a STEP-LEVEL signal. The pending entry and the pre-ask run directory are removed
 * exactly once here, then the denial is rethrown as `LaunchPermissionDenialError` so the launch's
 * failure handler steps aside instead of rendering tool text or cleaning up a second time.
 */
export async function requestLaunchPermission(request: PermissionRequest): Promise<void> {
  const { runId, context, deps, prepared, background, dryRun, projectedAgents } = request
  try {
    await deps.assertPermission({
      sessionID: context.sessionID,
      ...optional("agent", context.agent),
      action: WORKFLOW_TOOL,
      resources: [prepared.meta.name],
      save: [prepared.meta.name],
      metadata: {
        runId,
        name: prepared.meta.name,
        description: prepared.meta.description,
        phases: prepared.meta.phases?.map((phase) => phase.title) ?? [],
        dryRun,
        background,
        ...optional("projectedAgents", projectedAgents),
        ...(projectedAgents !== undefined && projectedAgents >= deps.options.largeWorkflowAgents
          ? { largeWorkflow: true }
          : {}),
      },
    })
  } catch (error) {
    dropPending(deps.coordinator, runId)
    await removeRunDir(runId)
    throw new LaunchPermissionDenialError(error)
  }
}

/**
 * A permission denial already cleaned up by `requestLaunchPermission`.
 *
 * It carries the ORIGINAL rejection: the host turns that exact value into a step cancellation, so
 * the launch rethrows it untouched rather than rendering or wrapping it.
 */
export class LaunchPermissionDenialError extends Error {
  readonly denial: unknown

  constructor(denial: unknown) {
    super(denial instanceof Error ? denial.message : String(denial))
    this.name = "LaunchPermissionDenialError"
    this.denial = denial
  }
}

/** The stop path's model-facing result. Dispatched at the boundary, before any launch decision. */
export async function stopWorkflow(
  runId: string,
  deps: Pick<LaunchGateDeps, "host" | "coordinator">,
): Promise<string> {
  const result = await stopRun(runId, deps.host, deps.coordinator)
  if (result.outcome === "not_found" || result.outcome === "stop_failed") {return result.detail}
  return [`<workflow-stopped run="${result.runId}">`, result.detail, "</workflow-stopped>"].join("\n")
}

/** The launch's default model, as the engine's `provider/model` string, when the host reports one. */
export async function defaultModelOf(host: Pick<HostPort, "defaultModel">): Promise<string | undefined> {
  let model: Awaited<ReturnType<HostPort["defaultModel"]>>
  try {
    model = await host.defaultModel()
  } catch {
    // A catalog read failure means "no known default", never a failed launch.
    return undefined
  }
  return model === undefined ? undefined : `${model.providerID}/${model.modelID}`
}

/** The deepest native ancestry recorded on a launch; a runaway chain cannot stall a tool call. */
export const MAX_ANCESTOR_DEPTH = 16

/**
 * The launching session's live native ancestors, nearest first.
 *
 * V2 child sessions are unparented on the host, so an agent child only knows the chain captured
 * here. Recording it lets `onV2Event` revoke stale pending permissions when a grandparent changes.
 * The walk is bounded and cycle-safe; a missing row ends it, because least lineage must never fail
 * a launch — the live permission walk still uses the direct parent unconditionally.
 */
export async function nativeAncestorSessionIDs(
  host: HostPort,
  sessionID: string,
  limit = MAX_ANCESTOR_DEPTH,
): Promise<string[]> {
  const chain: string[] = [],
   seen = new Set([sessionID])
  let current = sessionID
  while (chain.length < limit) {
    let parentID: string | undefined
    try {
      const session = await host.getSession(current)
      parentID = session?.parentID
    } catch {
      break
    }
    if (parentID === undefined || parentID === "" || seen.has(parentID)) {break}
    chain.push(parentID)
    seen.add(parentID)
    current = parentID
  }
  return chain
}

/**
 * Refreshes the saved-workflow command entries when a live rescan sees a new or changed file.
 *
 * `entries` is read by the (synchronous) command transform, so the transform picks up the new list
 * on the reload it is asked to perform.
 */
export function refreshCommandSurface(
  named: Record<string, string>,
  state: { entries: SavedWorkflow[]; readonly reload: () => void },
): void {
  const next = parseSavedWorkflows(named)
  if (signatureOf(state.entries) === signatureOf(next)) {return}
  state.entries = next
  state.reload()
}

function signatureOf(entries: readonly SavedWorkflow[]): string {
  return entries.map((entry) => `${entry.name}\u0000${entry.source}`).join("\u0001")
}

/**
 * The model-emitted zero-value decorations (#86): "", "null" and "undefined".
 *
 * One predicate for every field the launch boundary guards, so the decoration set stays a single
 * decided contract rather than per-field trivia.
 */
const isZeroValueDecoration = (value: string): boolean =>
  value === "" || value === "null" || value === "undefined"
