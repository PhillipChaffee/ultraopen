import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Reads live workflow progress for the TUI.
 *
 * Deliberately independent of the server half: it reads the run directory rather than receiving
 * pushed updates, because `ctx.metadata()` is a no-op for plugin tools and there is no other
 * server→TUI channel for arbitrary data. Reading from disk also works when the TUI is not the
 * process running the workflow.
 *
 * All logic lives here rather than in the JSX component so it can be tested without a terminal.
 */

export type AgentRow = {
  index: number
  label: string
  phase?: string | undefined
  status: "running" | "done" | "failed"
}

export type RunView = {
  runId: string
  workflow: string
  sessionID: string
  phase?: string | undefined
  agents: AgentRow[]
  done: number
  failed: number
  total: number
  /** Seconds since the run started, computed against a caller-supplied clock. */
  elapsedSeconds: number
  logs: string[]
}

type RawProgress = Partial<RunView> & { startedAt?: number; agents?: AgentRow[] }

/** Mirrors the server's XDG resolution so both halves agree on where runs live. */
export function dataRoot(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env["XDG_DATA_HOME"]
  const base = xdg && xdg.trim() !== "" ? xdg : join(home, ".local", "share")
  return join(base, "opencode", "tool-output", "ultraopen")
}

/**
 * Loads every run currently in progress for a session.
 *
 * A run counts as active while its manifest says `running`. Anything unreadable is skipped rather
 * than surfaced — a progress pane must never be the thing that breaks the UI.
 */
export async function activeRuns(options: {
  root: string
  sessionID: string
  now: number
}): Promise<RunView[]> {
  let names: string[]
  try {
    names = await readdir(options.root)
  } catch {
    return []
  }

  const views: RunView[] = []
  for (const name of names) {
    const view = await loadRun(join(options.root, name), options.sessionID, options.now)
    if (view) views.push(view)
  }
  // Oldest first, so a long-running workflow does not jump around as newer ones start and finish.
  return views.toSorted((a, b) => a.runId.localeCompare(b.runId))
}

async function loadRun(dir: string, sessionID: string, now: number): Promise<RunView | undefined> {
  const manifest = await readJson(join(dir, "manifest.json"))
  if (!manifest || manifest["status"] !== "running") return undefined
  if (manifest["sessionID"] !== sessionID) return undefined

  const progress = (await readJson(join(dir, "progress.json"))) as RawProgress | undefined
  if (!progress) return undefined

  return toView(progress, now)
}

/** Shapes a raw snapshot for display, tolerating a partially-written file. */
export function toView(progress: RawProgress, now: number): RunView {
  const agents = Array.isArray(progress.agents) ? progress.agents : []
  return {
    runId: typeof progress.runId === "string" ? progress.runId : "unknown",
    workflow: typeof progress.workflow === "string" ? progress.workflow : "workflow",
    sessionID: typeof progress.sessionID === "string" ? progress.sessionID : "",
    phase: progress.phase,
    agents,
    done: agents.filter((agent) => agent.status === "done").length,
    failed: agents.filter((agent) => agent.status === "failed").length,
    total: agents.length,
    elapsedSeconds: Math.max(0, Math.round((now - (progress.startedAt ?? now)) / 1000)),
    logs: Array.isArray(progress.logs) ? progress.logs : [],
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch {
    // A run mid-write, a partial file, or a directory that is not ours.
    return undefined
  }
}

/** `4m12s`, or `12s` under a minute. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** One-line summary, used by the compact surfaces. */
export function summarize(run: RunView): string {
  const phase = run.phase ? `${run.phase} ` : ""
  const failed = run.failed > 0 ? ` · ${run.failed} failed` : ""
  return `${run.workflow} · ${phase}${run.done}/${run.total} · ${formatElapsed(run.elapsedSeconds)}${failed}`
}

/** Status glyph for an agent row. */
export function glyph(status: AgentRow["status"]): string {
  if (status === "done") return "✓"
  if (status === "failed") return "✗"
  return "⠋"
}
