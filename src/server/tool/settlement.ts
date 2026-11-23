import { readFile } from "node:fs/promises"
import type { HostPort } from "../host/port.js"
import type { LiveRunRecord, ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import type { RpcRunStatus } from "../../rpc.js"
import type { UltraopenOptions } from "../options.js"
import { ProgressWriter } from "../resume/progress.js"
import { endRun, markCancelled, writeTerminalManifest } from "../resume/persist.js"
import { CONTROL_STOP_ABORT_REASON } from "../resume/journal.js"
import type { JournalEntry, Manifest } from "../resume/journal.js"
import { flushJournalEntry, readManifest, runDir, writeFailure } from "../resume/store.js"
import { watchControl } from "../runtime/control.js"
import type { ControlCommand } from "../runtime/control.js"
import { rpcViewFromProgress, terminalRpcStatus } from "../runtime/views.js"
import { deliverOutcomeUnlessStopped, runDetached } from "./background.js"
import { execute, renderFailure, WorkflowRunError } from "./workflow.js"
import { manifestTitleOf } from "./args-transport.js"
import { renderStopFailure, stopReasonOf } from "./render.js"
import type { PreparedWorkflow, WorkflowArgs } from "./workflow.js"

/**
 * The one execution wiring for a run that has a manifest on disk.
 *
 * Both detached contracts — the launch path's background branch and the boot-time auto-resume
 * sweep — need the identical machinery: the incremental journal flush chain, the progress writer
 * with crash-safe child persistence, the run-control channel, the runUpdated emissions, and the
 * ONE settle protocol. It lives here rather than in the two callers because the
 * flush-join-before-endRun ordering is crash safety, not style.
 */

/** The settle protocol's outcome shape, shared by every contract's settle path. */
export interface SettleOutcome {
  status: "completed" | "failed"
  entries: readonly JournalEntry[]
  value: unknown
  childSessionIDs: string[]
  failureText?: string | undefined
}

export interface SettlementSpec {
  runId: string
  /** The run's host. Callers pass the coordinator's reloadable proxy, so it stays live. */
  host: HostPort
  project: ProjectRuntime
  coordinator: RuntimeCoordinator
  sessionID: string
  /** The run's manifest, already on disk with status `running`. */
  manifest: Manifest
  /** The parsed workflow, ready to execute. */
  prepared: PreparedWorkflow
  /** The workflow args to execute with; `script` is inline and already resolved. */
  args: WorkflowArgs
  /** Plugin options: ceilings and the budget mirror. */
  options: UltraopenOptions
  /** The signal the run's engine obeys — the stop controller's for detached runs; the tool call's for blocking. */
  signal?: AbortSignal | undefined
  /** The run-level cancelled gate for child-list rewrites. */
  cancelGate?: (() => boolean) | undefined
  named?: Record<string, string> | undefined
  /** The session's default model, for effort resolution. */
  defaultModel?: string | undefined
  /** Journal entries replayed before live execution; empty or absent for a fresh run. */
  previousEntries?: readonly JournalEntry[] | undefined
  /** The run id the entries were replayed from, recorded on replayed entries. */
  resumedFrom?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  /** Injectable engine for tests. Defaults to the real engine. */
  executeFn?: typeof execute | undefined
  /** Reported on the hydration notification; the launch path carries the resume's own shape. */
  resume?: { resumed: number; argsChanged: boolean } | undefined
  /** Test seam: the child-list writer's manifest read. */
  readManifestFn?: typeof readManifest | undefined
  /** The control-channel stop-run hook, owned by the detached contract. */
  onControlStopRun?: (() => void) | undefined
  /** Sessions above the parent, nearest first, recorded on every child. */
  ancestorSessionIDs?: readonly string[] | undefined
  /** Repository root, enabling worktree isolation. */
  worktreeRoot?: string | undefined
}

export interface RunWiring {
  /** Receives each journal entry; appends it to the run's journal file, in record order. */
  flush: (entry: JournalEntry) => void
  /** The engine context: base context plus progress, journal, and control wiring. */
  executeContext: Parameters<typeof execute>[1]
  /**
   * Marks this run's own snapshot `stopping` (#175) and flushes it immediately.
   *
   * The stop path attaches this to the live record, so the flag lands on the in-memory snapshot
   * the engine keeps folding events into — not just on the file the next event would overwrite.
   */
  markStopping: () => Promise<void>
  /** The ONE settle protocol: join the flush chain, close the manifest, persist failure text. */
  settle: (outcome: SettleOutcome) => Promise<void>
}

/**
 * Assembles the shared execution wiring for one run.
 *
 * Inside `settle` the flushes are joined BEFORE the endRun rewrite, so the settled write can never
 * race a floating append. The terminal runUpdated is emitted after the manifest has closed, so a
 * TUI reacting to it finds the disk already settled.
 */
export function wireRun(spec: SettlementSpec): RunWiring {
  const { runId, manifest, coordinator, project } = spec,
   flushChain = { current: Promise.resolve() },
   flush = (entry: JournalEntry): void => {
     flushChain.current = flushChain.current.then(() => flushJournalEntry(runId, entry, spec.env))
   },
   progress = new ProgressWriter({
     runId,
     workflow: spec.prepared.meta.name,
     sessionID: spec.sessionID,
     startedAt: Date.now(),
     budgetTotal: spec.options.budgetTokens,
     ...(spec.env === undefined ? {} : { env: spec.env }),
   }),
   emit = (status: RpcRunStatus): void => {
     coordinator.emitRunUpdated(project.projectKey, rpcViewFromProgress(progress.snapshot, status))
   },
   /**
    * The status a progress-driven emission must carry.
    *
    * Once the run is stopping — through this writer's own snapshot, the engine's cancel gate, or
    * the live record the stop path flipped — an interleaved progress or note flush must never
    * publish `running` over the stop. All three sources are checked because the ordering between
    * them is a race, not a constant: the live record is set before `markStopping` flushes.
    */
   isStopping = (): boolean =>
     progress.snapshot.status === "stopping" ||
     spec.cancelGate?.() === true ||
     coordinator.runs.get(runId)?.status === "stopping",
   markStopping = async (): Promise<void> => await progress.markStopping(Date.now())

  // Crash safety: the manifest's child list is updated as sessions appear, so a server killed
  // mid-run leaves the reaper a list of children to interrupt. The on-disk status guard keeps an
  // unwind-time progress event from resurrecting a cancelled record.
  const readManifestOf = spec.readManifestFn ?? readManifest
  let persistedChildren = -1
  const writeChildren = async (): Promise<void> => {
    if (spec.cancelGate?.() === true) {return}
    const sessions = coordinator.sessionsOf(runId)
    if (sessions.length === persistedChildren) {return}
    persistedChildren = sessions.length
    try {
      const current = await readManifestOf(runId, spec.env)
      // The gate re-check after the await (#156): a call that passed before its read resolved must
      // not write when the cancel landed mid-read.
      if (spec.cancelGate?.() === true) {return}
      if (current !== undefined && current.status === "running") {
        // The child-list update carries the terminal-write discipline (#164).
        await writeTerminalManifest(runId, { ...current, childSessionIDs: sessions }, spec.env)
      }
    } catch {
      // Crash safety is best-effort: a failed manifest rewrite must not stall the run.
    }
  }

  let stopControl: (() => void) | undefined

  const executeContext: Parameters<typeof execute>[1] = {
    host: spec.host,
    project,
    coordinator,
    sessionID: spec.sessionID,
    runId,
    ancestorSessionIDs: spec.ancestorSessionIDs ?? [],
    deadlineMs: spec.options.agentDeadlineMs,
    idleMs: spec.options.agentIdleMs,
    readScript: (path: string) => readFile(path, "utf8"),
    ...(spec.defaultModel === undefined ? {} : { defaultModel: spec.defaultModel }),
    ...(spec.options.budgetTokens === null ? {} : { budgetTotal: spec.options.budgetTokens }),
    ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    ...(spec.named !== undefined && Object.keys(spec.named).length > 0 ? { named: spec.named } : {}),
    ...(spec.worktreeRoot === undefined ? {} : { worktreeRoot: spec.worktreeRoot }),
    onProgress: (event: Parameters<ProgressWriter["apply"]>[0]) => {
      progress.apply(event, Date.now())
      void progress.flush()
      emit(isStopping() ? "stopping" : "running")
      // Persist on agent-start AND on log lines: a stall restart spawns a NEW child session
      // without an agent-start, and a killed server must leave the reaper a list that includes it.
      if (event.type === "agent-start" || event.type === "log") {void writeChildren()}
    },
    onJournal: flush,
    registerControl: (dispatch: (command: ControlCommand) => void): void => {
      stopControl = watchControl({
        runId,
        runDir: runDir(runId, spec.env),
        dispatch:
          spec.onControlStopRun === undefined
            ? dispatch
            : (command: ControlCommand): void => {
                if (command.action === "stop-run") {spec.onControlStopRun?.()}
                dispatch(command)
              },
        onNote: (note) => {
          progress.apply({ type: "log", message: note }, Date.now())
          void progress.flush()
          emit(isStopping() ? "stopping" : "running")
        },
      })
    },
    ...(spec.previousEntries !== undefined && spec.previousEntries.length > 0
      ? { previousEntries: spec.previousEntries, ...(spec.resumedFrom === undefined ? {} : { resumedFrom: spec.resumedFrom }) }
      : {}),
  }

  const settle = async (outcome: SettleOutcome): Promise<void> => {
    stopControl?.()
    await flushChain.current
    await endRun(manifest, outcome, spec.env)
    if (outcome.failureText !== undefined) {
      try {
        await writeFailure(runId, outcome.failureText, spec.env)
      } catch {
        // Nothing better is knowable on a failed write; the manifest still closed.
      }
    }
    const standing = await readManifest(runId, spec.env)
    emit(terminalRpcStatus(standing?.status, outcome.status))
  }

  return { flush, executeContext, settle, markStopping }
}

/** The replayed-entry count of a (possibly partial) journal — the honest "replayed" number. */
function replayedCount(entries: readonly JournalEntry[] | undefined): number {
  return (entries ?? []).filter((entry) => entry.replayed === true).length
}

export interface DetachedRunSpec extends Omit<SettlementSpec, "signal" | "cancelGate"> {
  /** Builds the line prepended to the hydration notification body, given the replay count. */
  explain?: ((replayed: number) => string) | undefined
}

/**
 * The control-channel stop for a detached run: the TUI-side mirror of `stopRun` (#134).
 *
 * Snapshots the run's live children BEFORE anything unwinds, trips the engine signal with the
 * control channel's own abort reason, and records the manifest cancelled first-terminal-write-wins.
 * Fire-and-forget: the watcher's dispatch cannot await, and `markCancelled` never rejects.
 */
export function controlStopRun(
  manifest: Manifest,
  stopController: AbortController,
  coordinator: RuntimeCoordinator,
  env?: NodeJS.ProcessEnv,
): void {
  void (async (): Promise<void> => {
    const sessions = coordinator.sessionsOf(manifest.runId)
    stopController.abort(CONTROL_STOP_ABORT_REASON)
    await markCancelled(manifest, sessions, env)
  })()
}

/**
 * Starts a run under the detached contract and returns at once.
 *
 * The live record is registered before the task starts, so the stop path can find the controller
 * it must trip and the TUI can render the run. Hydration fires AFTER the settle protocol, through
 * the durable outbox, so a model reacting to the notification finds workflow_status settled.
 */
export function startDetachedRun(spec: DetachedRunSpec): void {
  const stopController = new AbortController(),
   explain = spec.explain,
   executeFn = spec.executeFn ?? execute,
   wiring = wireRun({
     ...spec,
     signal: stopController.signal,
     cancelGate: () => stopController.signal.aborted,
     onControlStopRun: (): void => {controlStopRun(spec.manifest, stopController, spec.coordinator, spec.env)},
   })

  const title = manifestTitleOf(spec.manifest.title),
   existing = spec.coordinator.runs.get(spec.runId),
   live: LiveRunRecord = existing ?? {
     runId: spec.runId,
     sessionID: spec.sessionID,
     projectKey: spec.project.projectKey,
     locationDir: spec.host.location.directory,
     status: "running",
     startedAt: Date.now(),
     name: spec.prepared.meta.name,
   }
  live.status = "running"
  live.stopController = stopController
  // The stop path marks the run through its OWN writer from here on, so a later progress event
  // cannot rewrite `progress.json` back to running.
  live.markStopping = wiring.markStopping
  live.name = spec.prepared.meta.name
  if (title !== undefined) {live.title = title}
  spec.coordinator.runs.set(spec.runId, live)

  void runDetached(spec.coordinator, {
    runId: spec.runId,
    manifest: spec.manifest,
    task: async (): Promise<void> => {
      const launchTitle = manifestTitleOf(spec.manifest.title)
      try {
        const result = await executeFn(spec.args, wiring.executeContext)
        await wiring.settle({
          status: "completed",
          entries: result.journal,
          value: result.value,
          childSessionIDs: result.childSessionIDs,
        })
        await deliverOutcomeUnlessStopped({
          host: spec.host,
          coordinator: spec.coordinator,
          sessionID: spec.manifest.sessionID,
          runId: spec.runId,
          workflow: spec.prepared.meta.name,
          ...(launchTitle === undefined ? {} : { title: launchTitle }),
          result,
          ...(spec.resume === undefined ? {} : { resume: spec.resume }),
          ...(explain === undefined ? {} : { prefix: explain(replayedCount(result.journal)) }),
          ...(spec.env === undefined ? {} : { env: spec.env }),
        })
      } catch (error) {
        const partial = error instanceof WorkflowRunError ? error.partial : undefined,
         stopReason = stopReasonOf(stopController.signal),
         failureText = stopReason === undefined
           ? renderFailure(error instanceof WorkflowRunError ? error.cause : error, spec.args.script, spec.runId)
           : renderStopFailure(stopReason, spec.runId)
        await wiring.settle({
          status: "failed",
          entries: partial?.journal ?? [],
          value: null,
          childSessionIDs: partial?.childSessionIDs ?? [],
          failureText,
        })
        await deliverOutcomeUnlessStopped({
          host: spec.host,
          coordinator: spec.coordinator,
          sessionID: spec.manifest.sessionID,
          runId: spec.runId,
          workflow: spec.prepared.meta.name,
          ...(launchTitle === undefined ? {} : { title: launchTitle }),
          failureText: explain === undefined ? failureText : `${explain(replayedCount(partial?.journal))}\n${failureText}`,
          ...(spec.env === undefined ? {} : { env: spec.env }),
        })
      }
    },
    renderFailure,
    ...(spec.env === undefined ? {} : { env: spec.env }),
  })
}
