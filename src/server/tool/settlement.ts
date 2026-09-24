import { readFile } from "node:fs/promises"
import type { UltraopenOptions } from "../options.js"
import { ProgressWriter } from "../resume/progress.js"
import { endRun } from "../resume/persist.js"
import type { JournalEntry, Manifest } from "../resume/journal.js"
import { flushJournalEntry, readManifest, runDir, writeFailure, writeManifest } from "../resume/store.js"
import { watchControl } from "../runtime/control.js"
import type { ControlCommand } from "../runtime/control.js"
import { registry } from "../singleton.js"
import type { OpencodeClient } from "../types.js"
import { deliverOutcomeUnlessStopped, registerStopHandle, runDetached } from "./background.js"
import { execute, renderFailure, WorkflowRunError } from "./workflow.js"
import type { PreparedWorkflow, WorkflowArgs } from "./workflow.js"

/**
 * The one execution wiring for a run that has a manifest on disk.
 *
 * Both detached contracts — the launch path's background branch and the boot-time auto-resume
 * sweep — need the identical machinery: the incremental journal flush chain, the progress writer
 * with crash-safe child persistence, the run-control channel, and the ONE settle protocol. It
 * lives here rather than in the two callers because the flush-join-before-endRun ordering is
 * crash safety, not style: two copies would drift, and a drift that lets a settled rewrite race a
 * floating append loses journal entries on the exact runs this exists to protect.
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
  client: OpencodeClient
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
  /**
   * The run-level cancelled gate for child-list rewrites: true once a stop is in
   * flight, so a stop's manifest writes can never race a child-list rewrite.
   * The detached contract gates on its stop controller; the blocking contract
   * has no stop surface and never cancels.
   */
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
}

export interface RunWiring {
  /** Receives each journal entry; appends it to the run's journal file, in record order. */
  flush: (entry: JournalEntry) => void
  /** The engine context: base context plus progress, journal, and control wiring. */
  executeContext: Parameters<typeof execute>[1]
  /** The ONE settle protocol: join the flush chain, close the manifest, persist failure text. */
  settle: (outcome: SettleOutcome) => Promise<void>
}

/**
 * Assembles the shared execution wiring for one run.
 *
 * Extracted from the launch path verbatim — the ordering inside `settle` (flushes settle BEFORE
 * the endRun rewrite, so the settled write can never race a floating append) is crash safety.
 */
export function wireRun(spec: SettlementSpec): RunWiring {
  const { runId, manifest } = spec,
    // Flushes are CHAINED (appends stay in record order and never interleave) and joined before
    // endRun, so the settled rewrite can never race a floating append. The store-level flush
    // never rejects — a disk failure must not lose a live run.
    flushChain = { current: Promise.resolve() },
    flush = (entry: JournalEntry): void => {
      flushChain.current = flushChain.current.then(() => flushJournalEntry(runId, entry, spec.env))
    },
    progress = new ProgressWriter({
      runId,
      workflow: spec.prepared.meta.name,
      sessionID: spec.sessionID,
      startedAt: Date.now(),
      // Mirrors the run's ceiling in the snapshot so the sidebar can show spend against it.
      // Null (uncapped) is passed through, not omitted, so the shape stays stable.
      budgetTotal: spec.options.budgetTokens,
      ...(spec.env === undefined ? {} : { env: spec.env }),
    })

  // Crash safety: the manifest's child list is updated as sessions appear, so a server killed
  // mid-run leaves the reaper a list of children to abort. The on-disk status guard keeps an
  // unwind-time progress event from resurrecting a cancelled record.
  let persistedChildren = -1
  const writeChildren = async (): Promise<void> => {
    // The cancelled gate is the run-level stop signal: once a stop is in flight, child-list
    // rewrites are moot and must not race the cancel write.
    if (spec.cancelGate?.() === true) {return}
    const sessions = registry.sessionsOf(runId)
    if (sessions.length === persistedChildren) {return}
    persistedChildren = sessions.length
    try {
      const current = await readManifest(runId, spec.env)
      if (current !== undefined && current.status === "running") {
        await writeManifest(runId, { ...current, childSessionIDs: sessions }, spec.env)
      }
    } catch {
      // Crash safety is best-effort: a failed manifest rewrite must not stall the run.
    }
  }

  // The run-control channel: a per-run watcher reads the TUI's control file
  // and dispatches to the Run; cleared when the run settles.
  let stopControl: (() => void) | undefined

  const executeContext: Parameters<typeof execute>[1] = {
    client: spec.client,
    sessionID: spec.sessionID,
    runId,
    deadlineMs: spec.options.agentDeadlineMs,
    idleMs: spec.options.agentIdleMs,
    // Makes the schema-advertised `scriptPath` real: persisted scripts under the run
    // directory can be re-run by path.
    readScript: (path: string) => readFile(path, "utf8"),
    ...(spec.defaultModel === undefined ? {} : { defaultModel: spec.defaultModel }),
    ...(spec.options.budgetTokens === null ? {} : { budgetTotal: spec.options.budgetTokens }),
    signal: spec.signal,
    ...(spec.named !== undefined && Object.keys(spec.named).length > 0 ? { named: spec.named } : {}),
    onProgress: (event: Parameters<ProgressWriter["apply"]>[0]) => {
      progress.apply(event, Date.now())
      void progress.flush()
      // Persist on agent-start AND on log lines: a stall restart spawns a NEW child
      // session without an agent-start, and a killed server must leave the reaper a
      // list that includes it. writeChildren no-ops when the list is unchanged, so
      // narration-heavy runs cost no extra writes.
      if (event.type === "agent-start" || event.type === "log") {void writeChildren()}
    },
    onJournal: flush,
    registerControl: (dispatch: (command: ControlCommand) => void): void => {
      stopControl = watchControl({
        runId,
        runDir: runDir(runId, spec.env),
        dispatch,
        onNote: (note) => {
          progress.apply({ type: "log", message: note }, Date.now())
          // The control channel is the only writer that folds notes without an
          // accompanying engine event, so it flushes its own log line — otherwise
          // the note would sit in the snapshot until the next progress event.
          void progress.flush()
        },
      })
    },
    ...(spec.previousEntries !== undefined && spec.previousEntries.length > 0
      ? { previousEntries: spec.previousEntries, ...(spec.resumedFrom === undefined ? {} : { resumedFrom: spec.resumedFrom }) }
      : {}),
  }

  const settle = async (outcome: SettleOutcome): Promise<void> => {
    stopControl?.()
    // The chain variable is read live: appends queued before this await are
    // included, however long the chain grew.
    await flushChain.current
    await endRun(manifest, outcome, spec.env)
    if (outcome.failureText !== undefined) {
      // Best-effort like every persistence here: a failed write must not
      // lose the settle itself.
      try {
        await writeFailure(runId, outcome.failureText, spec.env)
      } catch {
        // Nothing better is knowable on a failed write; the manifest still closed.
      }
    }
  }

  return { flush, executeContext, settle }
}

/** The replayed-entry count of a (possibly partial) journal — the honest "replayed" number. */
function replayedCount(entries: readonly JournalEntry[] | undefined): number {
  return (entries ?? []).filter((entry) => entry.replayed === true).length
}

export interface DetachedRunSpec extends Omit<SettlementSpec, "signal" | "cancelGate"> {
  /**
   * Builds the line prepended to the hydration notification body, given how
   * many agent calls the journal replayed. Omitted by the launch path, which
   * hydrates with the plain result render.
   */
  explain?: ((replayed: number) => string) | undefined
}

/**
 * Starts a run under the detached contract and returns at once.
 *
 * The task fully captures its own outcome — flushes, manifest, failure text —
 * because nothing else is waiting on it anymore, and hydration fires AFTER the
 * settle protocol so a model reacting to the notification finds
 * workflow_status settled, not "running". The caller has already registered the
 * launch-gating entry (registerPending) and, where a stop surface exists, will
 * find its controller via registerStopHandle below.
 */
export function startDetachedRun(spec: DetachedRunSpec): void {
  const stopController = new AbortController(),
    explain = spec.explain,
    executeFn = spec.executeFn ?? execute,
    wiring = wireRun({
      ...spec,
      signal: stopController.signal,
      cancelGate: () => stopController.signal.aborted,
    })

  registerStopHandle(spec.runId, stopController)
  void runDetached({
    runId: spec.runId,
    manifest: spec.manifest,
    task: async (): Promise<void> => {
      try {
        const result = await executeFn(spec.args, wiring.executeContext)
        await wiring.settle({
          status: "completed",
          entries: result.journal,
          value: result.value,
          // Captured inside the run before its cleanup forgot the sessions — reading the
          // registry here would always yield [].
          childSessionIDs: result.childSessionIDs,
        })
        // Hydration fires AFTER the settle protocol — the manifest is closed, so a model reacting
        // to the notification finds workflow_status settled, not "running".
        await deliverOutcomeUnlessStopped({
          client: spec.client,
          sessionID: spec.manifest.sessionID,
          runId: spec.runId,
          workflow: spec.prepared.meta.name,
          result,
          ...(spec.resume === undefined ? {} : { resume: spec.resume }),
          ...(explain === undefined ? {} : { prefix: explain(replayedCount(result.journal)) }),
        })
      } catch (error) {
        const partial = error instanceof WorkflowRunError ? error.partial : undefined,
          failureText = renderFailure(error instanceof WorkflowRunError ? error.cause : error, spec.args.script, spec.runId)
        await wiring.settle({
          status: "failed",
          entries: partial?.journal ?? [],
          value: null,
          childSessionIDs: partial?.childSessionIDs ?? [],
          failureText,
        })
        await deliverOutcomeUnlessStopped({
          client: spec.client,
          sessionID: spec.manifest.sessionID,
          runId: spec.runId,
          workflow: spec.prepared.meta.name,
          failureText: explain === undefined ? failureText : `${explain(replayedCount(partial?.journal))}\n${failureText}`,
        })
      }
    },
    // Last resort: the task above is contractually self-capturing, so an
    // escaping rejection means its own failure path broke. Route through the
    // same settle protocol — including the flush join — so the degraded
    // record still follows the crash-safety ordering. The degraded record is
    // disk-only (failure.txt + manifest); no hydration fires when even the
    // failure path broke.
    renderFailure,
  })
}