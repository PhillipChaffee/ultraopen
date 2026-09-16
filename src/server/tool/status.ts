import { parseJournal } from "../resume/journal.js"
import type { Manifest } from "../resume/journal.js"
import { isSafeRunId, runDir } from "../resume/store.js"
import { isProcessAlive } from "./background.js"

/**
 * The `workflow_status` tool: a disk-only read of a run's state.
 *
 * Disk is the single source of truth. The tool never touches a live Run object
 * and never spawns a session, so it answers identically from the process that
 * launched the run, from a fresh boot after a crash, and from a second session
 * entirely. Two calls in a row against unchanged files return the same numbers
 * by construction — every figure is derived from one read of one file.
 */

export interface StatusArgs {
  runId: string
  /** Seconds to poll for a settle before returning the current snapshot. */
  wait?: number
}

export const MAX_WAIT_SECONDS = 300
const POLL_INTERVAL_MS = 1000
/** Snapshot logs are capped for the same reason ProgressWriter caps its own. */
const MAX_LOG_LINES = 20

export interface StatusDeps {
  env?: NodeJS.ProcessEnv | undefined
  /** The boot id of the launching process; runs from other boots get liveness checks. */
  bootId?: string | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
  now?: (() => number) | undefined
  isAlive?: ((pid: number) => boolean) | undefined
  /** Reads one file as text. Injectable so tests never touch real disk. */
  readFile?: ((path: string) => Promise<string>) | undefined
  signal?: AbortSignal | undefined
}

export interface StatusReport {
  runId: string
  dir: string
  status: "running" | "completed" | "failed" | "orphaned"
  phase?: string | undefined
  phases: string[]
  agents: { total: number; running: number; done: number; failed: number }
  outputTokens: number
  value?: unknown
  failure?: { message: string; dir: string } | undefined
  logs: string[]
}

/**
 * Reads one run's state, waiting up to `wait` seconds for a terminal status.
 *
 * Each poll reads whole files, which the run's own writers rewrite whole, so a
 * snapshot is self-consistent. The loop ends early on a terminal status, on a
 * dead owner (`orphaned`), or when the parent turn's abort signal fires — the
 * run itself does not take that signal, the poll does.
 */
export async function executeStatus(args: StatusArgs, deps: StatusDeps = {}): Promise<StatusReport> {
  const env = deps.env,
   now = deps.now ?? (() => Date.now()),
   sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => {setTimeout(resolve, ms)})),
   isAlive = deps.isAlive ?? isProcessAlive,
   readFile = deps.readFile ?? defaultReadFile

  // The id is model-supplied input and joins into a filesystem path below, so a
  // malformed id is rejected before any read: an unknown run, never a traversal.
  if (typeof args.runId !== "string" || !isSafeRunId(args.runId)) {
    throw new Error(unknownRunMessage(String(args.runId), env))
  }

  const dir = runDir(args.runId, env),
   readJson = async <T>(path: string): Promise<T | undefined> => {
    try {return JSON.parse(await readFile(path)) as T} catch {return undefined}
   },
   manifestPath = `${dir}/manifest.json`,
   progressPath = `${dir}/progress.json`,
   journalPath = `${dir}/journal.jsonl`,
   resultPath = `${dir}/result.json`,
   cap = Math.min(MAX_WAIT_SECONDS, Math.max(0, args.wait ?? 0)),
   deadline = now() + cap * 1000

  for (;;) {
    const manifest = await readJson<Manifest>(manifestPath),
     progress = await readJson<ProgressFile>(progressPath)

    if (manifest === undefined && progress === undefined) {
      throw new Error(unknownRunMessage(args.runId, env))
    }

    const entries = await parseJournalSafe(await readFile(journalPath).catch(() => ""))
    const report = await buildSnapshot({ args, manifest, progress, entries, deps, isAlive, dir, resultPath, readFile })
    const settled = report.status !== "running" || deps.signal?.aborted === true || now() >= deadline
    if (settled) {return report}
    const remaining = deadline - now()
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining)))
  }
}

interface ProgressFile {
  phase?: string | undefined
  agents?: { status: string }[] | undefined
  logs?: string[] | undefined
}

interface JournalLine {
  key: string
  status?: string | undefined
  phase?: string | undefined
  outputTokens?: number | undefined
  replayed?: boolean | undefined
}

async function buildSnapshot(input: {
  args: StatusArgs
  manifest: Manifest | undefined
  progress: ProgressFile | undefined
  entries: JournalLine[]
  deps: StatusDeps
  isAlive: (pid: number) => boolean
  dir: string
  resultPath: string
  readFile: (path: string) => Promise<string>
}): Promise<StatusReport> {
  const { args, manifest, progress, entries, deps, isAlive, dir, resultPath, readFile } = input

  // A run still marked `running` whose owning process is gone will never
  // settle: report it orphaned so the model stops polling and looks at resume.
  // The boot check keeps a queued run in THIS process from reading as dead.
  let status: StatusReport["status"] = "running"
  if (manifest?.status === "completed" || manifest?.status === "failed") {status = manifest.status}
  else if (manifest?.status === "orphaned") {status = "orphaned"}
  if (
    status === "running" &&
    manifest !== undefined &&
    deps.bootId !== undefined &&
    manifest.bootId !== deps.bootId &&
    !isAlive(manifest.pid)
  ) {
    status = "orphaned"
  }

  // Replayed entries carry another run's spend; excluding them keeps the total
  // equal to what THIS run actually paid. Retry attempts are real spend.
  const outputTokens = entries
    .filter((entry) => entry.replayed !== true)
    .reduce((sum, entry) => sum + (typeof entry.outputTokens === "number" ? entry.outputTokens : 0), 0)

  const phases = uniqueInOrder(
    entries.map((entry) => entry.phase).filter((phase): phase is string => typeof phase === "string"),
  )
  if (typeof progress?.phase === "string" && !phases.includes(progress.phase)) {phases.push(progress.phase)}

  const report: StatusReport = {
    runId: args.runId,
    dir,
    status,
    phase: progress?.phase,
    phases,
    agents: countAgents(progress, entries),
    outputTokens,
    logs: (progress?.logs ?? []).slice(-MAX_LOG_LINES),
  }

  if (status === "completed") {
    try {report.value = JSON.parse(await input.readFile(resultPath))} catch {report.value = undefined}
  }
  if (status === "failed" || status === "orphaned") {
    const failurePath = `${dir}/failure.txt`
    let persisted: string | undefined
    try {
      const text = await readFile(failurePath)
      if (text.trim() !== "") {persisted = text}
    } catch {
      // No persisted text; the fallback message below explains the state.
    }
    report.failure = {
      message: persisted ?? (status === "orphaned"
        ? "The run's owning process died before it could settle. Resume it with workflow(resumeFromRunId)."
        : "The run failed; no failure text was persisted."),
      dir,
    }
  }
  return report
}

/**
 * Live agent counts come from the progress snapshot. When it is missing (a
 * crash before the first coalesced flush) the settled journal stands in: the
 * latest entry per key wins, so a retry that later succeeded counts once, as
 * done. `running: 0` there is honest — without a snapshot nothing can be
 * observed running.
 */
function countAgents(progress: ProgressFile | undefined, entries: JournalLine[]): StatusReport["agents"] {
  if (progress?.agents !== undefined) {
    const agents = progress.agents
    const running = agents.filter((entry) => entry.status === "running").length,
     done = agents.filter((entry) => entry.status === "done").length,
     failed = agents.filter((entry) => entry.status === "failed").length
    return { total: agents.length, running, done, failed }
  }
  const latest = new Map<string, JournalLine>()
  for (const entry of entries) {latest.set(entry.key, entry)}
  let done = 0,
   failed = 0
  for (const entry of latest.values()) {
    if (entry.status === "ok") {done++} else {failed++}
  }
  return { total: latest.size, running: 0, done, failed }
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)]
}

function unknownRunMessage(runId: string, env?: NodeJS.ProcessEnv): string {
  return `No run found for id "${runId}". Checked ${runDir(runId, env)}. ` +
    "Pass the run id exactly as the workflow launch result reported it."
}

function parseJournalSafe(text: string): JournalLine[] {
  return parseJournal(text).map((entry): JournalLine => {
    const line: JournalLine = { key: entry.key, status: entry.status, outputTokens: entry.outputTokens }
    if (entry.phase !== undefined) {line.phase = entry.phase}
    if (entry.replayed !== undefined) {line.replayed = entry.replayed}
    return line
  })
}

async function defaultReadFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises")
  return await fs.readFile(path, "utf8")
}