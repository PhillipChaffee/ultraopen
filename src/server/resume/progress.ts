import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runDir } from "./store.js"
import type { ProgressEvent } from "../runtime/run.js"

/**
 * Live progress, written to the run directory.
 *
 * The TUI cannot be pushed to: `ctx.metadata()` is a no-op for plugin tools (opencode builds the
 * update but never runs it), and the transcript renderer only knows about built-in tools. So
 * progress goes to disk and the TUI half reads it. That also makes it work across processes —
 * the TUI is not necessarily the process running the workflow.
 */

export type AgentProgress = {
  index: number
  label: string
  phase?: string | undefined
  status: "running" | "done" | "failed"
}

export type ProgressSnapshot = {
  runId: string
  workflow: string
  sessionID: string
  phase?: string | undefined
  agents: AgentProgress[]
  logs: string[]
  startedAt: number
  updatedAt: number
}

export const PROGRESS_FILE = "progress.json"

export function progressPath(runId: string, env?: NodeJS.ProcessEnv): string {
  return join(runDir(runId, env), PROGRESS_FILE)
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
  readonly #flush: (path: string, body: string) => Promise<void>
  #dirty = false
  #writing = false

  constructor(options: {
    runId: string
    workflow: string
    sessionID: string
    startedAt: number
    env?: NodeJS.ProcessEnv | undefined
    /** Injectable for tests. Defaults to a real file write. */
    write?: ((path: string, body: string) => Promise<void>) | undefined
  }) {
    this.snapshot = {
      runId: options.runId,
      workflow: options.workflow,
      sessionID: options.sessionID,
      agents: [],
      logs: [],
      startedAt: options.startedAt,
      updatedAt: options.startedAt,
    }
    this.#env = options.env
    this.#flush = options.write ?? ((path, body) => writeFile(path, body, "utf8"))
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
      case "agent-end": {
        const agent = this.snapshot.agents.find((entry) => entry.index === event.index)
        if (agent) agent.status = event.ok ? "done" : "failed"
        // A replayed call never emits agent-start, so record it here rather than losing it.
        else this.snapshot.agents.push({ index: event.index, label: event.label, phase: event.phase, status: event.ok ? "done" : "failed" })
        break
      }
    }
    this.snapshot.updatedAt = now
    this.#dirty = true
  }

  /**
   * Writes the snapshot if anything changed.
   *
   * Best-effort and non-overlapping: a failed or slow write must not stall the run, and progress
   * is by definition disposable — the authoritative record is the journal.
   */
  async flush(): Promise<void> {
    if (!this.#dirty || this.#writing) return
    this.#writing = true
    this.#dirty = false
    try {
      await this.#flush(progressPath(this.snapshot.runId, this.#env), JSON.stringify(this.snapshot))
    } catch {
      // Ignored: see above.
    } finally {
      this.#writing = false
    }
  }
}
