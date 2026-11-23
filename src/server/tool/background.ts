import { readFile } from "node:fs/promises"
import type { HostPort } from "../host/port.js"
import type { LiveRunRecord, RuntimeCoordinator } from "../runtime/coordinator.js"
import type { Manifest } from "../resume/journal.js"
import { STOP_ABORT_REASON } from "../resume/journal.js"
import { endRun, markCancelled } from "../resume/persist.js"
import { progressPath } from "../resume/progress.js"
import type { ProgressSnapshot } from "../resume/progress.js"
import {
  atomicWriteFile,
  artifactPaths,
  deletePendingNotification,
  isProcessAlive,
  isSafeRunId,
  readManifest,
  runDir,
  writeFailure,
  writePendingNotification,
} from "../resume/store.js"
import type { PendingNotification } from "../resume/store.js"
import { rpcViewFromLive } from "../runtime/views.js"
import { manifestTitleOf } from "./args-transport.js"
import { renderResult, titleAttributeOf } from "./render.js"
import type { WorkflowResult } from "./workflow.js"

// The constants live in the journal module (the stop reasons are journal-recorded state);
// re-exported for the callers that read them off this module.
export { STOP_ABORT_REASON, CONTROL_STOP_ABORT_REASON } from "../resume/journal.js"

/** Which launch contract the host process can honor, decided from the process shape. */
export type HostShape = "shared-service" | "ephemeral"

/**
 * Classifies the host process.
 *
 * Every `--standalone` CLI command spawns `serve --stdio --port 0`, whose stdin EOF kills the
 * server with the parent command, so `--stdio` and `run` are ephemeral. `service`, `serve`, `web`
 * and `acp` without `--stdio` own a long-lived service lifetime. Anything unknown is ephemeral:
 * freeing the turn in a process that dies loses the run, while pinning a shared service merely
 * blocks the chat — the failure directions are not symmetric.
 */
export function classifyHost(argv: readonly string[] = process.argv): HostShape {
  const tokens = argv.slice(1)
  if (tokens.includes("--stdio") || tokens.includes("run")) {return "ephemeral"}
  return tokens.some((token) => token === "service" || token === "serve" || token === "web" || token === "acp") ? "shared-service" : "ephemeral"
}

/** `true` only for a service-owned host that outlives the invoking CLI. */
export function isLongLivedHost(argv: readonly string[] = process.argv): boolean {
  return classifyHost(argv) === "shared-service"
}

/** The hydration notification's size cap, in characters. */
export const HYDRATION_CAP = 4096

/** Cuts text to the cap at a line boundary, never splitting a line (so never splitting a tag). */
export function capAtLineBoundary(text: string, cap: number = HYDRATION_CAP): string {
  if (text.length <= cap) {return text}
  const lines = text.split("\n")
  let kept = ""
  for (const line of lines) {
    const candidate = kept === "" ? line : `${kept}\n${line}`
    if (candidate.length > cap && kept !== "") {break}
    kept = candidate
  }
  return kept
}

export interface HydrationOutcome {
  status: "completed" | "failed"
  workflow: string
  runId: string
  /** The launch's title metadata (#142), shown beside the workflow name. */
  title?: string | undefined
  /** The rendered result (completed) or failure text (failed) to wrap and cap. */
  body: string
}

/**
 * Renders the synthetic notification for one settled run.
 *
 * The body is capped and the full artifact is named on the pointer line — `result.json` for a
 * completion, `failure.txt` for a failure. The pointer is appended AFTER the cap so a failure's
 * own trailing run-dir line survives the cut.
 */
export function renderNotification(outcome: HydrationOutcome): string {
  const tag = outcome.status === "completed" ? "workflow-completed" : "workflow-failed",
   titleAttribute = titleAttributeOf(outcome.title),
   { resultPath, failurePath } = artifactPaths(outcome.runId),
   full = outcome.status === "completed" ? `full result: ${resultPath}` : `full failure: ${failurePath}`
  return [
    `<${tag} run="${outcome.runId}" workflow="${outcome.workflow}"${titleAttribute}>`,
    capAtLineBoundary(outcome.body),
    `</${tag}>`,
    full,
  ].join("\n")
}

/** The deterministic admission outcome, including the cancellation gate's own result. */
export type DeliveryResult = "admitted" | "session-missing" | "conflict" | "error" | "cancelled"

const OUTCOME_PREFIX = "msg_ultraopen_outcome_"
const STOP_PREFIX = "msg_ultraopen_stop_"

const outboxOf = (sessionID: string, outcome: HydrationOutcome): PendingNotification => ({
  id: `${OUTCOME_PREFIX}${outcome.runId}`,
  sessionID,
  runId: outcome.runId,
  workflow: outcome.workflow,
  status: outcome.status,
  text: renderNotification(outcome),
  description: `Workflow ${outcome.workflow} ${outcome.status}`,
})

/**
 * Admits the outcome message into the parent session.
 *
 * V2's compound `session.synthetic` double handles inbox/transcript delivery directly and
 * idempotently on the deterministic `msg_` id, so V1's idle nudge is gone. Never throws: the
 * settle protocol already closed the manifest, and a failed hydration must not reverse that.
 */
export async function hydrateParent(host: HostPort, sessionID: string, outcome: HydrationOutcome): Promise<DeliveryResult> {
  try {
    return await host.admitSynthetic({
      sessionID,
      id: `${OUTCOME_PREFIX}${outcome.runId}`,
      text: renderNotification(outcome),
      description: `Workflow ${outcome.workflow} ${outcome.status}`,
      metadata: {
        ultraopen: { kind: "outcome", runId: outcome.runId, workflow: outcome.workflow, status: outcome.status },
      },
      delivery: "steer",
      resume: true,
    })
  } catch {
    return "error"
  }
}

interface OutcomeDeliveryOptions {
  host: HostPort
  coordinator: RuntimeCoordinator
  sessionID: string
  runId: string
  workflow: string
  title?: string | undefined
  result?: WorkflowResult
  resume?: { resumed: number; argsChanged: boolean }
  failureText?: string
  prefix?: string
  env?: NodeJS.ProcessEnv | undefined
  /** Test seam: the two manifest reads around the outbox write. */
  readManifestFn?: typeof readManifest | undefined
}

const outcomeOf = (options: OutcomeDeliveryOptions): HydrationOutcome => {
  const prefixLine = options.prefix === undefined ? "" : `${options.prefix}\n`,
   title = options.title === undefined ? {} : { title: options.title }
  if (options.result !== undefined) {
    return {
      status: "completed",
      workflow: options.workflow,
      runId: options.runId,
      ...title,
      body: `${prefixLine}${renderResult(
        options.result,
        options.resume,
        siblingRunsForSession(options.coordinator, options.sessionID, options.runId),
      )}`,
    }
  }
  return {
    status: "failed",
    workflow: options.workflow,
    runId: options.runId,
    ...title,
    body: `${prefixLine}${options.failureText ?? ""}`,
  }
}

/**
 * Delivers a settled run's outcome unless a stop won the manifest, through the durable outbox.
 *
 * The outbox write sits between two manifest reads: a cancel that lands after the first read but
 * before admission deletes the file and suppresses the message, so a run the user stopped never
 * appears to have finished on its own. A host `error` keeps the file for the next boot's replay;
 * `admitted` and `session-missing` both mean the message can never be owed again.
 */
export async function deliverOutcomeUnlessStopped(options: OutcomeDeliveryOptions): Promise<DeliveryResult> {
  const read = options.readManifestFn ?? readManifest,
   outcome = outcomeOf(options),
   beforeWrite = await read(options.runId, options.env)
  if (beforeWrite?.status === "cancelled") {return "cancelled"}
  try {
    await writePendingNotification(outboxOf(options.sessionID, outcome), options.env)
  } catch {
    // Losing crash durability must not lose the live delivery; the manifest is already closed.
  }
  const afterWrite = await read(options.runId, options.env)
  if (afterWrite?.status === "cancelled") {
    await deletePendingNotification(options.runId, options.env)
    return "cancelled"
  }
  const result = await hydrateParent(options.host, options.sessionID, outcome)
  if (result === "admitted" || result === "session-missing") {
    await deletePendingNotification(options.runId, options.env)
  }
  return result
}

/**
 * The stop confirmation, admitted into the run's own parent session.
 *
 * Informational only: `resume` defaults to false, so a stop never wakes an idle conversation just
 * to say it stopped. The deterministic id makes a retry idempotent.
 */
export async function notifyStopped(host: HostPort, sessionID: string, runId: string, workflow: string | undefined, options: { resume?: boolean | undefined } = {}): Promise<DeliveryResult> {
  try {
    return await host.admitSynthetic({
      sessionID,
      id: `${STOP_PREFIX}${runId}`,
      text: [
        `<workflow-stopped run="${runId}"${nameAttribute(workflow)}>`,
        "Stopped by request: this run's subagents were aborted and the run is recorded as cancelled. " +
          "No completion notification will arrive.",
        "</workflow-stopped>",
      ].join("\n"),
      description: `Workflow ${workflow ?? "run"} stopped`,
      metadata: { ultraopen: { kind: "stopped", runId, ...(workflow === undefined ? {} : { workflow }) } },
      delivery: "steer",
      resume: options.resume ?? false,
    })
  } catch {
    return "error"
  }
}

const nameAttribute = (workflow: string | undefined): string =>
  workflow === undefined || workflow === "" ? "" : ` workflow="${workflow}"`

/** The launch-gating record's creation fields, resolved by the launch path. */
export interface PendingRunInput {
  runId: string
  sessionID: string
  projectKey: string
  locationDir: string
  name?: string | undefined
  title?: string | undefined
}

/** Registers a launch synchronously, so the check-then-act launch gate has one writer. */
export function registerPending(
  coordinator: RuntimeCoordinator,
  input: PendingRunInput,
  startedAt: number = Date.now(),
): LiveRunRecord {
  const record: LiveRunRecord = {
    runId: input.runId,
    sessionID: input.sessionID,
    projectKey: input.projectKey,
    locationDir: input.locationDir,
    status: "pending",
    startedAt,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.title === undefined ? {} : { title: input.title }),
  }
  coordinator.runs.set(input.runId, record)
  return record
}

export function promote(coordinator: RuntimeCoordinator, runId: string): void {
  const run = coordinator.runs.get(runId)
  if (run?.status === "pending") {run.status = "running"}
}

/** Records a launch's workflow name and title once the script has parsed (#142). */
export function nameRun(coordinator: RuntimeCoordinator, runId: string, name: string, title?: string | undefined): void {
  const run = coordinator.runs.get(runId)
  if (run === undefined) {return}
  run.name = name
  const present = manifestTitleOf(title)
  if (present !== undefined) {run.title = present}
}

/** Drops a pending entry — the launch failed before the run went live. */
export function dropPending(coordinator: RuntimeCoordinator, runId: string): void {
  if (coordinator.runs.get(runId)?.status === "pending") {coordinator.runs.delete(runId)}
}

/** Drops a settled run's entry, whatever status it holds. */
export function dropSettled(coordinator: RuntimeCoordinator, runId: string): void {
  coordinator.runs.delete(runId)
}

/** The session's live entries, oldest start first. */
export function liveRunsForSession(coordinator: RuntimeCoordinator, sessionID: string): LiveRunRecord[] {
  return [...coordinator.runs.values()]
    .filter((run) => run.sessionID === sessionID)
    .toSorted((left, right) => left.startedAt - right.startedAt)
}

/** The session's live entries except the named run. */
export function siblingRunsForSession(coordinator: RuntimeCoordinator, sessionID: string, excludeRunId: string): LiveRunRecord[] {
  return liveRunsForSession(coordinator, sessionID).filter((run) => run.runId !== excludeRunId)
}

/** True while the run is registered under this process's coordinator. */
export function isLive(coordinator: RuntimeCoordinator, runId: string): boolean {
  return coordinator.runs.has(runId)
}

/** True when the manifest names an owner still running, in this process or another live pid. */
export function isLiveAnywhere(manifest: Manifest, coordinator: RuntimeCoordinator): boolean {
  if (manifest.status !== "running") {return false}
  return manifest.bootId === coordinator.processBootId ? isLive(coordinator, manifest.runId) : isProcessAlive(manifest.pid)
}

/** Resolves when the named detached run has fully settled (or is unknown). */
export function settlePromiseOf(coordinator: RuntimeCoordinator, runId: string): Promise<void> {
  return coordinator.settlingOf(runId)
}

/**
 * Runs one detached task, with the degraded settle for an escaping rejection.
 *
 * The final cleanup drops the run and its child lineage from the coordinator, so a settled run
 * leaves no live residue and no stale activity record.
 */
export function runDetached(
  coordinator: RuntimeCoordinator,
  options: {
    runId: string
    manifest: Manifest | undefined
    task: () => Promise<void>
    onEscapedRejection?: ((error: unknown) => Promise<void>) | undefined
    renderFailure: (error: unknown, source?: string, runId?: string) => string
    env?: NodeJS.ProcessEnv | undefined
  },
): Promise<void> {
  promote(coordinator, options.runId)
  const promise = (async (): Promise<void> => {
    try {
      await options.task()
    } catch (error) {
      await writeFailure(options.runId, options.renderFailure(error), options.env).catch((): undefined => undefined)
      await endRun(options.manifest, { status: "failed", entries: [], value: null, childSessionIDs: [] }, options.env)
      await options.onEscapedRejection?.(error)
    } finally {
      coordinator.runs.delete(options.runId)
      coordinator.forgetRunChildren(options.runId)
    }
  })()
  // The coordinator owns the settle promise: it outlives the live record deleted above, so the
  // stop path and status callers can still join a run that finished between their reads.
  coordinator.trackSettling(options.runId, promise)
  return promise
}

/** The bounded wait the stop path gives a child interrupt or an engine unwind. */
const DEFAULT_STOP_TIMEOUT_MS = 1000

interface Bounded<T> {
  readonly done: boolean
  readonly value?: T
}

async function within<T>(promise: Promise<T>, ms: number): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Bounded<T>>((resolve) => {
    timer = setTimeout(() => {resolve({ done: false })}, ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      promise.then((value): Bounded<T> => ({ done: true, value })),
      timeout,
    ])
  } finally {
    if (timer !== undefined) {clearTimeout(timer)}
  }
}

/**
 * The stop marker for a run with NO wiring attached — a blocking launch whose settle has not
 * started, or a record from a previous build. A missing progress file is a no-op.
 */
async function markProgressStoppingOnDisk(runId: string, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  try {
    const snapshot = JSON.parse(await readFile(progressPath(runId, env), "utf8")) as ProgressSnapshot
    snapshot.status = "stopping"
    snapshot.updatedAt = Date.now()
    await atomicWriteFile(progressPath(runId, env), JSON.stringify(snapshot))
  } catch {
    // A run without a progress file (a very early stop) has nothing to mark.
  }
}

/** The stop path's result: the RPC layer maps these outcomes to its own typed errors. */
export interface StopRunResult {
  runId: string
  outcome: "stopped" | "already_completed" | "already_stopped" | "not_found" | "stop_failed"
  detail: string
}

export interface StopRunOptions {
  env?: NodeJS.ProcessEnv | undefined
  /** Bounded wait for each child interrupt and for the engine's own unwind. */
  interruptTimeoutMs?: number | undefined
  markCancelledFn?: typeof markCancelled | undefined
}

/**
 * Stops one live run with confirmed settlement (#175).
 *
 * Ordering is the contract: the live record, progress file and RPC event all say `stopping`
 * BEFORE any child is interrupted, so a poller never sees a half-stopped run. The cancel is
 * committed last, after the interrupts and a bounded engine settle, and only then does the
 * result claim `stopped`. A natural completion that wins the race reports `already_completed`;
 * an interrupt the host cannot confirm reports `stop_failed` rather than a false success.
 */
export async function stopRun(
  runId: string,
  host: HostPort,
  coordinator: RuntimeCoordinator,
  options: StopRunOptions = {},
): Promise<StopRunResult> {
  const result = (outcome: StopRunResult["outcome"], detail: string): StopRunResult => ({ runId, outcome, detail })
  if (!isSafeRunId(runId)) {
    return result("not_found", `"${runId}" is not a valid run id — pass the id exactly as the launch result reported it.`)
  }
  const manifest = await readManifest(runId, options.env)
  if (manifest === undefined) {
    return result("not_found", `No workflow run with id "${runId}" exists.`)
  }
  if (manifest.status === "cancelled") {return result("already_stopped", `Run "${runId}" is already cancelled.`)}
  if (manifest.status !== "running") {
    return result("already_completed", `Run "${runId}" already finished with status "${manifest.status}".`)
  }
  const live = coordinator.runs.get(runId)
  if (live === undefined) {
    return result(
      "not_found",
      manifest.bootId !== coordinator.processBootId && isProcessAlive(manifest.pid)
        ? `Run "${runId}" is executing in another opencode process (pid ${manifest.pid}) — stop it from that session instead.`
        : `Run "${runId}" is not live in this opencode process — nothing to stop.`,
    )
  }

  live.status = "stopping"
  // The run's OWN writer first: `markStopping` sets the in-memory snapshot status synchronously
  // before it awaits the flush, so a progress event interleaved with that flush already sees
  // `stopping` and can never emit `running` over the stop. The disk fallback covers a record whose
  // wiring has not assembled yet.
  await (live.markStopping === undefined
    ? markProgressStoppingOnDisk(runId, options.env)
    : live.markStopping())
  coordinator.emitRunUpdated(live.projectKey, rpcViewFromLive(live, "stopping"))
  live.stopController?.abort(STOP_ABORT_REASON)

  const sessions = coordinator.sessionsOf(runId),
   timeoutMs = options.interruptTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
   interrupts = await within(Promise.allSettled(sessions.map(async (id) => await host.interruptSession(id))), timeoutMs),
   unconfirmed = interrupts.done !== true ||
     interrupts.value?.some((entry) => entry.status === "rejected" || entry.value !== true) === true

  if (live.settling !== undefined) {await within(live.settling, timeoutMs)}

  const settled = await (options.markCancelledFn ?? markCancelled)(manifest, sessions, options.env)
  // A natural completion that won the race still owes its settlement notification: deleting the
  // outbox here would lose the crash-gap payload the boot sweep replays. Only a cancel owns the
  // delete (a cancelled run must never be hydrated as finished).
  if (settled?.status === "cancelled") {await deletePendingNotification(runId, options.env)}

  if (settled?.status !== "cancelled") {
    if (settled?.status === "completed") {return result("already_completed", `Run "${runId}" completed while the stop was being applied.`)}
    return result(
      "stop_failed",
      `Run "${runId}" settled with status "${settled?.status ?? "unknown"}" while the stop was being applied — nothing was stopped.`,
    )
  }
  if (unconfirmed) {
    return result(
      "stop_failed",
      `Run "${runId}" was cancelled, but its child sessions could not be confirmed stopped within ${timeoutMs}ms.`,
    )
  }
  // The durable half of the stop contract (T6b): the tool result tells the MODEL, and this
  // synthetic tells the PARENT TRANSCRIPT what happened. `resume: false` is intentional — a
  // stopped run must never wake an idle conversation just to announce that nothing is running.
  await notifyStopped(host, live.sessionID, live.runId, live.name)
  coordinator.emitRunUpdated(live.projectKey, rpcViewFromLive(live, "stopped"))
  return result("stopped", `Run "${runId}" stopped. Completed agents remain on disk for a later resume — run dir: ${runDir(runId, options.env)}`)
}
