import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { atomicWriteFile, runDir } from "./store.js"
import type { ProgressEvent } from "../runtime/run.js"

/**
 * Live progress, written to the run directory.
 *
 * The TUI cannot be pushed to: `ctx.metadata()` is a no-op for plugin tools (opencode builds the
 * update but never runs it), and the transcript renderer only knows about built-in tools. So
 * progress goes to disk and the TUI half reads it. That also makes it work across processes —
 * the TUI is not necessarily the process running the workflow.
 */

export interface AgentProgress {
  index: number
  label: string
  phase?: string | undefined
  status: "running" | "done" | "failed"
  /**
   * The failure's machine reason (`aborted`, `idle-deadline`, …), copied from the agent-end
   * event. The journal's own reason stays the settled source of truth for a status report; this
   * field exists so the LIVE view can name why a row failed without reading the journal.
   */
  reason?: string | undefined
  /** The agent's output-token spend, once its call has settled. */
  outputTokens?: number | undefined
  /**
   * The child session id, once one exists (#150): set the moment the spawn creates the child
   * and carried through agent-end. Absent for a replayed agent — no session is spawned, so
   * there is none to name — and for a row whose child failed at spawn itself.
   */
  sessionID?: string | undefined
}

export interface ProgressSnapshot {
  runId: string
  workflow: string
  sessionID: string
  /**
   * The run's V2 lifecycle state (#175). `stopping` is written the instant a stop is
   * requested, before the children have unwound and before the manifest settles as
   * `cancelled`, so the TUI and the status tool can show the stop in flight. Absent on
   * snapshots written before the field existed (readers treat absent as `running`).
   */
  status?: "running" | "stopping"
  phase?: string | undefined
  agents: AgentProgress[]
  logs: string[]
  startedAt: number
  updatedAt: number
  /**
   * The run's output-token budget and live spend. Always present (total null = uncapped) so
   * the shape the sidebar reads stays stable; spent accumulates from agent-end events and
   * mirrors `budget.spent()` in the script's own `budget` global.
   */
  budget: { total: number | null; spent: number }
}

export const PROGRESS_FILE = "progress.json"

/** Snapshot logs are capped — the TUI re-reads this file every poll and never shows history. */
export const MAX_SNAPSHOT_LOGS = 200

export function progressPath(runId: string, env?: NodeJS.ProcessEnv): string {
  return join(runDir(runId, env), PROGRESS_FILE)
}

/**
 * Reads one run's progress snapshot, tolerating a missing or torn file.
 *
 * Deliberately total: progress is disposable by design (the journal is authoritative), so a
 * reader that cannot parse it answers "no snapshot" rather than rejecting a run listing.
 */
export async function readProgressSnapshot(
  runId: string,
  env?: NodeJS.ProcessEnv,
): Promise<ProgressSnapshot | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(progressPath(runId, env), "utf8"))
    // A total reader: `null`, an array, or any non-object JSON is not a snapshot. Returning it
    // would crash the first `progress.workflow` / `progress.agents` access in a listing.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {return undefined}
    return parsed as ProgressSnapshot
  } catch {
    return undefined
  }
}

/**
 * Accumulates progress events into a snapshot and writes it out.
 *
 * Writes are coalesced on a short timer rather than issued per event: a 15-agent run emits
 * hundreds of transitions, and one file write each would be pointless I/O for a display that
 * refreshes far more slowly than that.
 */
export class ProgressWriter {
  readonly snapshot: ProgressSnapshot
  readonly #env: NodeJS.ProcessEnv | undefined
  readonly #inject: { failRename?: boolean } | undefined
  readonly #flush: (path: string, body: string) => Promise<void>
  #dirty = false
  #flushing: Promise<void> | undefined

  constructor(options: {
    runId: string
    workflow: string
    sessionID: string
    startedAt: number
    /** The run's output-token ceiling; null (or omitted) means uncapped. */
    budgetTotal?: number | null | undefined
    env?: NodeJS.ProcessEnv | undefined
    /** Injectable for tests. Defaults to a real file write. */
    write?: ((path: string, body: string) => Promise<void>) | undefined
    /**
     * Test-only fault injection, passed to the DEFAULT write (#136 review): lets a test fail the
     * rename after the temp write — the killed-mid-write shape — and so pin that the default
     * flush is atomic rather than a truncate-write. Unused when `write` is supplied.
     */
    inject?: { failRename?: boolean } | undefined
  }) {
    this.snapshot = {
      runId: options.runId,
      workflow: options.workflow,
      sessionID: options.sessionID,
      status: "running",
      agents: [],
      logs: [],
      startedAt: options.startedAt,
      updatedAt: options.startedAt,
      budget: { total: options.budgetTotal ?? null, spent: 0 },
    }
    this.#env = options.env
    this.#inject = options.inject
    // The default flush is atomic (#136): a torn progress file would blind the TUI and the status
    // poll. The fault-inject seam rides along so tests can kill this exact path mid-write.
    this.#flush = options.write ?? ((path, body) => atomicWriteFile(path, body, this.#inject))
  }

  /** Folds one event into the snapshot. */
  apply(event: ProgressEvent, now: number): void {
    switch (event.type) {
      case "phase": {
        this.snapshot.phase = event.title
        break
      }
      case "log": {
        this.snapshot.logs.push(event.message)
        if (this.snapshot.logs.length > MAX_SNAPSHOT_LOGS) {
          this.snapshot.logs.splice(0, this.snapshot.logs.length - MAX_SNAPSHOT_LOGS)
        }
        break
      }
      case "agent-start": {
        this.snapshot.agents.push({
          index: event.index,
          label: event.label,
          phase: event.phase,
          status: "running",
        })
        break
      }
      case "agent-session": {
        // The spawn just created the child: the row agent-start announced gains its id. The
        // event is never a row creator by itself — agent-start (or a replayed agent-end)
        // always lands first, and a row-less fold here would manufacture an agent the
        // schedule never started; ignored when absent.
        const agent = this.snapshot.agents.find((entry) => entry.index === event.index)
        if (agent) {agent.sessionID = event.sessionID}
        break
      }
      case "agent-end": {
        const tokens = typeof (event as { outputTokens?: unknown }).outputTokens === "number"
          ? (event as { outputTokens: number }).outputTokens
          : undefined
        const sessionID = typeof (event as { sessionID?: unknown }).sessionID === "string"
          ? (event as { sessionID: string }).sessionID
          : undefined
        const agent = this.snapshot.agents.find((entry) => entry.index === event.index)
        if (agent) {
          agent.status = event.ok ? "done" : "failed"
          if (tokens !== undefined) {agent.outputTokens = tokens}
          if (sessionID !== undefined) {agent.sessionID = sessionID}
          if (event.reason !== undefined) {agent.reason = event.reason}
        }
        // A replayed call never emits agent-start, so record it here rather than losing it.
        else {
          this.snapshot.agents.push({
            index: event.index,
            label: event.label,
            phase: event.phase,
            status: event.ok ? "done" : "failed",
            ...(tokens === undefined ? {} : { outputTokens: tokens }),
            ...(sessionID === undefined ? {} : { sessionID }),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          })
        }
        // The run-scoped spend accumulator: every settled call's outputTokens feeds it, the
        // same way the run's records feed `budget.spent()`. Failed agents contribute their
        // (zero) spend, so the running total matches the journal.
        if (tokens !== undefined) {this.snapshot.budget.spent += tokens}
        break
      }
    }
    this.snapshot.updatedAt = now
    this.#dirty = true
  }

  /**
   * Records that a stop has been requested (#175) and flushes it immediately.
   *
   * The manifest stays `running` until the children have unwound, so the snapshot is the
   * only surface that can report the stop in flight. Marking it dirty alone would leave the
   * last coalesced write as the final word; the explicit flush makes the state observable to
   * the next poll rather than whenever the next event happens to arrive.
   */
  async markStopping(now: number): Promise<void> {
    this.snapshot.status = "stopping"
    this.snapshot.updatedAt = now
    this.#dirty = true
    await this.flush()
  }

  /**
   * Writes the snapshot until it is clean, serializing every caller onto one flush.
   *
   * Best-effort and non-overlapping: a failed or slow write must not stall the run, and progress
   * is by definition disposable — the authoritative record is the journal. A caller that arrives
   * while a write is in flight gets THAT promise, not an early return: the drain loop re-checks
   * `#dirty` after every write, so `await markStopping()` only resolves once the `stopping`
   * snapshot has actually reached disk.
   */
  flush(): Promise<void> {
    if (this.#flushing !== undefined) {return this.#flushing}
    if (!this.#dirty) {return Promise.resolve()}
    this.#flushing = (async (): Promise<void> => {
      try {
        while (this.#dirty) {
          this.#dirty = false
          try {
            await this.#flush(progressPath(this.snapshot.runId, this.#env), JSON.stringify(this.snapshot))
          } catch {
            // Ignored: see above.
          }
        }
      } finally {
        this.#flushing = undefined
      }
    })()
    return this.#flushing
  }
}
