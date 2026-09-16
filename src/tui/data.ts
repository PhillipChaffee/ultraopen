import { readFile, readdir, unlink } from "node:fs/promises"
import { LARGE_RUN_AGENTS } from "../server/script/limits.js"
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

export interface AgentRow {
  index: number
  label: string
  phase?: string | undefined
  status: "running" | "done" | "failed"
  /** Why the agent failed, from the journal's latest null entry for its key. */
  reason?: string | undefined
  /** The agent's output-token spend, from the progress snapshot. */
  outputTokens?: number | undefined
}

export interface RunView {
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
  const xdg = env["XDG_DATA_HOME"],
   base = xdg && xdg.trim() !== "" ? xdg : join(home, ".local", "share")
  return join(base, "opencode", "tool-output", "ultraopen")
}

/**
 * Loads every run currently in progress for a session.
 *
 * A run counts as active while its manifest says `running`. Anything unreadable is skipped rather
 * than surfaced — a progress pane must never be the thing that breaks the UI.
 */
/**
 * Loads every active run view, without filtering by session.
 *
 * Split from `activeRuns` so one poll of the directory can serve every subscriber surface.
 */
export async function loadAllRuns(root: string, now: number): Promise<RunView[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const views: RunView[] = []
  for (const name of names) {
    const view = await loadRun(join(root, name), now)
    if (view) {views.push(view)}
  }
  // Oldest first, so a long-running workflow does not jump around as newer ones start and finish.
  return views.toSorted((a, b) => a.runId.localeCompare(b.runId))
}

/** Runs belonging to one session. */
export async function activeRuns(options: {
  root: string
  sessionID: string
  now: number
}): Promise<RunView[]> {
  const views = await loadAllRuns(options.root, options.now)
  return views.filter((view) => view.sessionID === options.sessionID)
}

async function loadRun(dir: string, now: number): Promise<RunView | undefined> {
  const manifest = await readJson(join(dir, "manifest.json"))
  if (!manifest || manifest["status"] !== "running") {return undefined}

  const progress = (await readJson(join(dir, "progress.json"))) as RawProgress | undefined
  if (!progress) {return undefined}

  const view = toView(progress, now)
  // The manifest is the authority on which session owns the run; older snapshots may not carry it.
  if (view.sessionID === "" && typeof manifest["sessionID"] === "string") {
    view.sessionID = manifest["sessionID"]
  }
  // Failure reasons live in the journal, not the progress snapshot; a half-failed
  // run must explain itself right in the sidebar, with no new server code.
  if (view.failed > 0) {
    const reasons = await loadFailedReasons(dir)
    for (const agent of view.agents) {
      if (agent.status === "failed") {agent.reason = reasons.get(agent.label)}
    }
  }
  return view
}

/**
 * Reads a run journal and maps each failed agent's label to its latest reason.
 *
 * One agent can appear several times (a stall restart writes another entry for
 * the same key); the newest entry wins. Best-effort: a missing, torn, or
 * hand-edited journal yields an empty map, never a throw.
 */
export async function loadFailedReasons(dir: string): Promise<Map<string, string>> {
  let text: string
  try {
    text = await readFile(join(dir, "journal.jsonl"), "utf8")
  } catch {
    return new Map()
  }
  const reasons = new Map<string, string>()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") {continue}
    try {
      const entry = JSON.parse(trimmed) as { label?: unknown; status?: unknown; reason?: unknown }
      if (entry.status !== "null" || typeof entry.label !== "string" || typeof entry.reason !== "string") {
        continue
      }
      reasons.set(entry.label, entry.reason)
    } catch {
      // A torn tail line is the crash mode of a mid-write kill; skip it.
    }
  }
  return reasons
}

/** Shapes a raw snapshot for display, tolerating a partially-written file. */
export function toView(progress: RawProgress, now: number): RunView {
  // Each element is validated too: a valid array containing nulls (hand-edited or corrupt file)
  // must degrade to a shorter list, never throw — a throw here loops on every poll cycle.
  const agents = (Array.isArray(progress.agents) ? progress.agents : []).filter(
    (agent): agent is AgentRow =>
      typeof agent === "object" && agent !== null && typeof (agent as AgentRow).status === "string",
  )
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
    // Bounded window: the poller re-reads the whole file every second and never renders history.
    logs: Array.isArray(progress.logs) ? progress.logs.filter((line) => typeof line === "string").slice(-200) : [],
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
  if (seconds < 60) {return `${seconds}s`}
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** One-line summary, used by the compact surfaces. */
export function summarize(run: RunView): string {
  const phase = run.phase ? `${run.phase} ` : "",
   failed = run.failed > 0 ? ` · ${run.failed} failed` : "",
   // Advice only: a run this large is worth a look at the fan-out. Same
   // threshold as the server's own warning, so both surfaces agree.
   large = run.total >= LARGE_RUN_AGENTS ? " · large run" : ""
  return `${run.workflow} · ${phase}${run.done}/${run.total} · ${formatElapsed(run.elapsedSeconds)}${failed}${large}`
}

/** Status glyph for an agent row. */
export function glyph(status: AgentRow["status"]): string {
  if (status === "done") {return "✓"}
  if (status === "failed") {return "✗"}
  return "⠋"
}

/** One agent row's text: glyph, label, and the failure reason when there is one. */
export const INTERRUPTED_MARKER = "interrupted.txt"

/**
 * One directory pass for interrupted-run hints.
 *
 * Called once per TUI boot and cached, so startup cost is one readdir pass no
 * matter how many old runs exist. A run hints when its directory holds the
 * reaper's marker — which only orphaning writes, so completed and failed runs
 * never hint. Best-effort: a missing or malformed marker is skipped, never a
 * startup failure.
 */
export async function loadInterruptedRuns(root: string): Promise<InterruptedHint[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const hints: InterruptedHint[] = []
  for (const name of names) {
    let marker: string
    try {
      marker = await readFile(join(root, name, INTERRUPTED_MARKER), "utf8")
    } catch {
      continue
    }
    if (marker.trim() === "") {continue}
    const manifest = await readJson(join(root, name, "manifest.json"))
    // The manifest carries no workflow name; the progress snapshot does, and a
    // synthetic run may have neither — the run id alone is still a usable hint.
    const progress = await readJson(join(root, name, "progress.json"))
    let workflowName = "workflow"
    if (typeof progress?.["workflow"] === "string") {workflowName = progress["workflow"]}
    else if (typeof manifest?.["workflow"] === "string") {workflowName = manifest["workflow"] as string}
    hints.push({
      runId: typeof manifest?.["runId"] === "string" ? (manifest["runId"] as string) : name,
      workflow: workflowName,
    })
  }
  return hints
}

/** The hint line: names the run and the way back. */
export function hintLine(hint: InterruptedHint): string {
  return `interrupted: ${hint.workflow} (${hint.runId}) — ask to resume it`
}

/**
 * Consumes a displayed hint's marker.
 *
 * The once-only behavior is per RUN, not per boot: the first boot that displays
 * a hint removes its marker, so a second start shows nothing. The orphaned
 * manifest itself persists until the run is resumed or retention prunes it —
 * what is consumed is the HINT, not the record. Best-effort: a failed delete
 * only means the hint shows one more boot.
 */
export async function consumeInterruptedMarker(root: string, runId: string): Promise<void> {
  await unlink(join(root, runId, INTERRUPTED_MARKER)).catch(() => undefined)
}

export function agentRowText(agent: AgentRow): string {
  const reason = agent.status === "failed" && agent.reason ? ` — ${agent.reason}` : "",
   tokens = typeof agent.outputTokens === "number" && agent.outputTokens > 0 ? ` · ${formatTokens(agent.outputTokens)}` : ""
  return `${glyph(agent.status)} ${agent.label}${reason}${tokens}`
}

/** Compact token count: `1.2k`, `345`, `1.1m`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {return `${Math.round((tokens / 1_000_000) * 10) / 10}m`}
  if (tokens >= 1000) {return `${Math.round((tokens / 1000) * 10) / 10}k`}
  return String(tokens)
}

/**
 * Writes one control command into a run's control file (the run-control
 * channel: TUI writes, server reads). The sequence number must exceed every
 * command already in the file; the caller derives it from the current line
 * count. Best-effort: a failed write surfaces nowhere — the next attempt
 * rewrites the whole file.
 */
export async function writeControlCommand(
  runDir: string,
  command: { action: string; target?: number | undefined },
  seq: number,
): Promise<void> {
  const { appendFile } = await import("node:fs/promises")
  const { action, target } = command
  const line = JSON.stringify({ seq, action, ...(target === undefined ? {} : { target }) })
  await appendFile(`${runDir}/control.jsonl`, `${line}\n`, "utf8")
}

export interface InterruptedHint {
  runId: string
  workflow: string
}

/** The marker the reaper writes into a run directory when it releases it. */

export type RunsListener = (runs: RunView[]) => void

interface TimerBag {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

/**
 * One polling timer shared by every surface.
 *
 * The sidebar, bottom strip and prompt status each used to run their own `setInterval`, so a
 * session with all three slots open read the same directories two or three times a second. The
 * poller reads once per tick and fans the result out to every subscriber, filtered per session.
 */
export class RunPoller {
  readonly #root: () => string
  readonly #pollMs: number
  readonly #timers: TimerBag
  readonly #subscribers = new Map<RunsListener, () => string>()
  #timer: unknown = undefined

  constructor(options: {
    root: () => string
    pollMs?: number | undefined
    timers?: TimerBag | undefined
  }) {
    this.#root = options.root
    this.#pollMs = options.pollMs ?? 1000
    this.#timers = options.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    }
  }

  /** Subscribes a surface to run updates for its (live-evaluated) session. Returns the unsubscribe fn. */
  subscribe(sessionID: () => string, listener: RunsListener): () => void {
    this.#subscribers.set(listener, sessionID)
    this.#start()
    void this.#refresh()
    return () => {
      this.#subscribers.delete(listener)
      if (this.#subscribers.size === 0) {this.#stop()}
    }
  }

  #start(): void {
    if (this.#timer !== undefined) {return}
    this.#timer = this.#timers.setInterval(() => void this.#refresh(), this.#pollMs)
  }

  #stop(): void {
    if (this.#timer === undefined) {return}
    this.#timers.clearInterval(this.#timer)
    this.#timer = undefined
  }

  async #refresh(): Promise<void> {
    // One directory pass, dispatched per subscriber — each surface polls a different session.
    const views = await loadAllRuns(this.#root(), Date.now())
    for (const [listener, sessionID] of this.#subscribers) {
      listener(views.filter((view) => view.sessionID === sessionID()))
    }
  }
}
