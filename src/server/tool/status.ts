import { parseJournal } from "../resume/journal.js"
import type { Manifest } from "../resume/journal.js"
import { artifactPaths, isSafeRunId, recordingPath, runDir } from "../resume/store.js"
import type { ManifestRead } from "../resume/store.js"
import type { ProgressSnapshot } from "../resume/progress.js"
import { isProcessAlive } from "./background.js"
import { manifestTitleOf } from "./args-transport.js"

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
/**
 * (#136) The terminal manifest is the settle's commit point; its artifacts (result.json for
 * completed, failure.txt for failed) land right after it. A read that races the settle would
 * return a settled report with its value missing — so a terminal report whose artifact has not
 * landed keeps polling within this grace, then returns whatever stands.
 */
const COHERENCE_GRACE_MS = 2000
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

/**
 * One agent of one run, as `workflow_status` reports it (#150).
 *
 * `index` and `sessionID` exist only when the progress snapshot supplied them: the journal —
 * the fallback when a snapshot is missing or torn — records neither, and a degraded row is an
 * honest row rather than an invented one. `recordingPath` is derived through the store's
 * per-agent path contract the same way only when the row carries both an index and a spawned
 * child session id — a replayed agent spawns nothing and records nothing, so its row points
 * nowhere rather than at a file that can only be read as missing.
 */
export interface StatusAgentRow {
  index?: number | undefined
  label: string
  status: "running" | "done" | "failed"
  phase?: string | undefined
  /** The latest journal-recorded failure reason, when the row failed. */
  reason?: string | undefined
  outputTokens?: number | undefined
  sessionID?: string | undefined
  /** The recording's canonical path, present when the row has an index and a child session. */
  recordingPath?: string | undefined
}

export interface StatusReport {
  runId: string
  dir: string
  /**
   * `corrupt` (#136): the run dir exists but its manifest is unreadable — a distinct, surfaced
   * state, never collapsed into "no run found". The journal may still be intact beside it.
   */
  status: "running" | "completed" | "failed" | "cancelled" | "orphaned" | "corrupt"
  phase?: string | undefined
  phases: string[]
  /**
   * The launch's `title` metadata (#142), from the manifest — the report renders it in the
   * opening tag. Absent on untitled runs and on the corrupt state (no manifest to read).
   */
  title?: string | undefined
  agents: { total: number; running: number; done: number; failed: number }
  /**
   * One row per agent, in call order (#150). The progress snapshot supplies labels, phases,
   * statuses, spends and child session ids while it is readable; on a missing or torn
   * snapshot the journal stands in (the same fallback the aggregate counts use), honestly
   * narrower — the journal records no index and no child ids, so those fields stay absent.
   */
  agentRows: StatusAgentRow[]
  outputTokens: number
  /**
   * The run's output-token budget and live spend, from the progress snapshot.
   * `total` null means uncapped — or unknown: a run whose snapshot never
   * reached disk has no ceiling to report. The render stays silent on null.
   */
  budget: { total: number | null; spent: number }
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
   isAlive = deps.isAlive ?? isProcessAlive

  // The id is model-supplied input and joins into a filesystem path below, so a
  // malformed id is rejected before any read: an unknown run, never a traversal.
  if (typeof args.runId !== "string" || !isSafeRunId(args.runId)) {
    throw new Error(unknownRunMessage(String(args.runId), env))
  }

  // The artifact layout is the store's contract, not this module's: paths come
  // from the module that writes them, so a writer-side change can never
  // silently strand this reader.
  const paths = artifactPaths(args.runId, env),
   dir = paths.dir,
   readFile = deps.readFile ?? defaultReadFile,
   readJson = async <T>(path: string): Promise<T | undefined> => {
    try {return JSON.parse(await readFile(path)) as T} catch {return undefined}
   },
   // JSON.parse throws SyntaxError on torn content; a failed READ (ENOENT) rejects instead —
   // the distinction IS the corrupt state (#136). The injected test reader rejects for missing
   // files and resolves garbage for planted corruption, so both paths are exercisable.
   readManifestRead = async (): Promise<ManifestRead> => {
    try {
      return { state: "ok", manifest: JSON.parse(await readFile(paths.manifestPath)) as Manifest }
    } catch (error) {
      if (error instanceof SyntaxError) {return { state: "corrupt", dir }}
      return { state: "missing" }
    }
   },
   cap = Math.min(MAX_WAIT_SECONDS, Math.max(0, args.wait ?? 0)),
   deadline = now() + cap * 1000
  let coherenceDeadline: number | undefined

  for (;;) {
    const manifestRead: ManifestRead = await readManifestRead(),
     manifest = manifestRead.state === "ok" ? manifestRead.manifest : undefined,
     progress = await readJson<ProgressSnapshot>(paths.progressPath)

    if (manifestRead.state === "corrupt") {
      // Terminal: polling cannot repair a torn file. Surface the state distinctly (#136) —
      // never "No run found" for a dir that exists.
      return {
        runId: args.runId,
        dir,
        status: "corrupt",
        phases: [],
        agents: { total: 0, running: 0, done: 0, failed: 0 },
        agentRows: [],
        outputTokens: 0,
        budget: { total: null, spent: 0 },
        failure: {
          message: "The run directory exists but its manifest is unreadable (a torn or corrupt write). " +
            "The journal beside it may still be intact — inspect the directory manually.",
          dir,
        },
        logs: [],
      }
    }

    if (manifest === undefined && progress === undefined) {
      throw new Error(unknownRunMessage(args.runId, env))
    }

    const entries = await parseJournalSafe(await readFile(paths.journalPath).catch(() => ""))
    const report = await buildSnapshot({ args, manifest, progress, entries, deps, isAlive, dir, resultPath: paths.resultPath, failurePath: paths.failurePath, readFile })

    let artifactPath: string | undefined
    if (report.status === "completed") {artifactPath = paths.resultPath}
    else if (report.status === "failed") {artifactPath = paths.failurePath}
    let artifactPresent = true
    if (artifactPath !== undefined) {
      try {
        await readFile(artifactPath)
      } catch {
        artifactPresent = false
      }
    }
    if (!artifactPresent && coherenceDeadline === undefined) {coherenceDeadline = now() + COHERENCE_GRACE_MS}
    const graceExpired = coherenceDeadline !== undefined && now() >= coherenceDeadline
    const settled =
      (report.status !== "running" && (artifactPresent || graceExpired)) ||
      deps.signal?.aborted === true ||
      graceExpired ||
      (now() >= deadline && report.status === "running")
    if (settled) {return report}
    const remaining = deadline - now()
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, remaining)))
  }
}

interface JournalLine {
  key: string
  label: string
  status?: string | undefined
  phase?: string | undefined
  reason?: string | undefined
  outputTokens?: number | undefined
  replayed?: boolean | undefined
}

async function buildSnapshot(input: {
  args: StatusArgs
  manifest: Manifest | undefined
  progress: ProgressSnapshot | undefined
  entries: JournalLine[]
  deps: StatusDeps
  isAlive: (pid: number) => boolean
  dir: string
  resultPath: string
  failurePath: string
  readFile: (path: string) => Promise<string>
}): Promise<StatusReport> {
  const { args, manifest, progress, entries, deps, isAlive, dir, resultPath, failurePath, readFile } = input

  // A run still marked `running` whose owning process is gone will never
  // settle: report it orphaned so the model stops polling and looks at resume.
  // The boot check keeps a queued run in THIS process from reading as dead.
  let status: StatusReport["status"] = "running"
  if (manifest?.status === "completed" || manifest?.status === "failed") {status = manifest.status}
  else if (manifest?.status === "cancelled") {status = "cancelled"}
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

  // The launch's title metadata (#142), under the same presence rule every manifest reader
  // applies (a hand-edited blank/decoration/non-string degrades to absent).
  const launchTitle = manifestTitleOf(manifest?.title)

  const report: StatusReport = {
    runId: args.runId,
    dir,
    status,
    ...(launchTitle === undefined ? {} : { title: launchTitle }),
    phase: progress?.phase,
    phases,
    agents: countAgents(progress, entries),
    agentRows: agentRowsOf(progress, entries, args.runId, deps.env),
    outputTokens,
    // The snapshot's own budget record, verbatim — the same field the sidebar
    // reads. Guarded per-member: a snapshot predating the budget field (or a
    // torn write) degrades to uncapped-unknown rather than crashing the read.
    budget: {
      total: typeof progress?.budget?.total === "number" ? progress.budget.total : null,
      spent: typeof progress?.budget?.spent === "number" ? progress.budget.spent : 0,
    },
    logs: (progress?.logs ?? []).slice(-MAX_LOG_LINES),
  }

  if (status === "completed") {
    try {report.value = JSON.parse(await input.readFile(resultPath))} catch {report.value = undefined}
  }
  if (status === "failed" || status === "orphaned") {
    // failure.txt lives beside the other artifacts; the path is the store's contract.
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
function countAgents(progress: ProgressSnapshot | undefined, entries: JournalLine[]): StatusReport["agents"] {
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

/**
 * The per-agent rows (#150), degrading the way the counts do.
 *
 * Snapshot rows carry everything: call order (by index), phase, status, settled spend, the
 * child session id once spawned, and the recording path the store's contract derives — the
 * path appears on a row only when a child session exists, because that is exactly the set of
 * agents a recording can belong to (replayed agents spawn nothing, record nothing). When no
 * snapshot is readable the journal takes over, honestly narrower: the journal holds labels,
 * statuses, phases, spends and failure reasons but no indices and no child ids, so those
 * fields stay absent instead of being invented. Failure reasons arrive from the journal in
 * BOTH cases — the snapshot never carries one.
 */
function agentRowsOf(
  progress: ProgressSnapshot | undefined,
  entries: JournalLine[],
  runId: string,
  env?: NodeJS.ProcessEnv,
): StatusAgentRow[] {
  const reasons = latestFailureReasons(entries),
    rowOf = (index: number | undefined, label: string, tail: { status: StatusAgentRow["status"]; phase?: string | undefined; outputTokens?: number | undefined; sessionID?: string | undefined }): StatusAgentRow => {
      const row: StatusAgentRow = {
        ...(index === undefined ? {} : { index }),
        label,
        status: tail.status,
        ...(tail.phase === undefined ? {} : { phase: tail.phase }),
        ...(reasons.get(label) === undefined ? {} : { reason: reasons.get(label) }),
        ...(tail.outputTokens === undefined ? {} : { outputTokens: tail.outputTokens }),
        ...(tail.sessionID === undefined ? {} : { sessionID: tail.sessionID }),
        ...(tail.sessionID === undefined || index === undefined ? {} : { recordingPath: recordingPath(runId, index, label, env) }),
      }
      return row
    }

  if (progress?.agents !== undefined && Array.isArray(progress.agents)) {
    return progress.agents.map((agent) =>
      rowOf(
        agent.index,
        agent.label,
        {
          status: agent.status,
          phase: agent.phase,
          outputTokens: agent.outputTokens,
          sessionID: agent.sessionID,
        },
      ),
    )
  }
  // Journal fallback: the latest entry per key decides each row's settled state, exactly the
  // map the aggregate counts build. Rows keep their journal order; `running` is never honest
  // from a journal alone, so every row reads done or failed.
  const latest = new Map<string, JournalLine>()
  for (const entry of entries) {latest.set(entry.key, entry)}
  return [...latest.values()].map((entry) =>
    rowOf(undefined, entry.label, {
      status: entry.status === "ok" ? "done" : "failed",
      phase: entry.phase,
      outputTokens: entry.outputTokens,
    }),
  )
}

/** Each failed label's latest journal-recorded reason — one sweep, no per-row re-read. */
function latestFailureReasons(entries: JournalLine[]): Map<string, string> {
  const reasons = new Map<string, string>()
  for (const entry of entries) {
    if (entry.status === "ok" || entry.reason === undefined) {continue}
    reasons.set(entry.label, entry.reason)
  }
  return reasons
}

function unknownRunMessage(runId: string, env?: NodeJS.ProcessEnv): string {
  return `No run found for id "${runId}". Checked ${runDir(runId, env)}. ` +
    "Pass the run id exactly as the workflow launch result reported it."
}

function parseJournalSafe(text: string): JournalLine[] {
  return parseJournal(text).map((entry): JournalLine => {
    const line: JournalLine = { key: entry.key, label: entry.label, status: entry.status, outputTokens: entry.outputTokens }
    if (entry.phase !== undefined) {line.phase = entry.phase}
    if (entry.reason !== undefined) {line.reason = entry.reason}
    if (entry.replayed !== undefined) {line.replayed = entry.replayed}
    return line
  })
}

async function defaultReadFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises")
  return await fs.readFile(path, "utf8")
}