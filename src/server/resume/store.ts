import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJournal } from "./journal.js"
import type { JournalEntry, Manifest } from "./journal.js"

/**
 * On-disk layout for workflow runs.
 *
 * Artifacts live under `<data>/opencode/tool-output/ultraopen/<runId>/`. That parent directory is
 * ALREADY whitelisted for agent reads on every agent, appended after user config, so the model can
 * read `journal.jsonl` and `result.json` with no permission prompt and WITHOUT this plugin writing
 * any permission config. Writing that config is not merely unnecessary but actively unsafe: the
 * top-level permission value can legitimately be a bare string, so merging into it would either
 * throw or shred the user's setting.
 *
 * Two hard constraints on naming, both learned rather than guessed:
 *
 * 1. No path component may begin with `tool_`. opencode's own cleanup job filters on that prefix
 *    and then parses the remainder as a timestamp, so a non-conforming `tool_*` name would make it
 *    throw and abort cleanup for every user of the machine.
 * 2. Because of (1) our directories are invisible to that reaper, so ultraopen ships its own.
 */

const NAMESPACE = "ultraopen"

/** Mirrors opencode's XDG resolution: $XDG_DATA_HOME, else ~/.local/share. */
export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env["XDG_DATA_HOME"],
   base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode", "tool-output", NAMESPACE)
}

export function runDir(runId: string, env?: NodeJS.ProcessEnv): string {
  return join(dataRoot(env), runId)
}

export interface RunArtifacts {
  dir: string
  journalPath: string
  manifestPath: string
  progressPath: string
  resultPath: string
  scriptPath: string
  failurePath: string
}

/**
 * The per-agent recording's filename base, deterministic from the agent call's index and
 * label (#150 / ADR-0004).
 *
 * Labels are free script text — a prompt fragment when the script passed none — so they are
 * not path-safe as given: every character outside the safe set collapses to `-`, the segment
 * caps at 48 characters, and a label that sanitizes to nothing falls back to `agent` so the
 * name is never empty. The zero-padded index keeps a directory listing in call order; the
 * label suffix keeps it readable by eye. This function and `recordingPath` below are the ONLY
 * path source for recordings — readers never string-build the shape.
 */
export function recordingFileBase(index: number, label: string): string {
  const safe =
    label
      .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 48) || "agent"
  return `${String(index).padStart(4, "0")}-${safe}`
}

/** The run directory's recordings subdirectory — one JSONL file per agent. */
export function recordingsDir(runId: string, env?: NodeJS.ProcessEnv): string {
  return join(runDir(runId, env), "recordings")
}

/** The deterministic path of one agent's recording file. */
export function recordingPath(runId: string, index: number, label: string, env?: NodeJS.ProcessEnv): string {
  return join(recordingsDir(runId, env), `${recordingFileBase(index, label)}.jsonl`)
}

export function artifactPaths(runId: string, env?: NodeJS.ProcessEnv): RunArtifacts {
  const dir = runDir(runId, env)
  return {
    dir,
    journalPath: join(dir, "journal.jsonl"),
    manifestPath: join(dir, "manifest.json"),
    progressPath: join(dir, "progress.json"),
    resultPath: join(dir, "result.json"),
    scriptPath: join(dir, "script.js"),
    failurePath: join(dir, "failure.txt"),
  }
}

/**
 * The durable settlement outbox (#180): one file per run holding the notification the host
 * still owes the parent session.
 *
 * The terminal manifest is committed FIRST, then this file is written, then the notification
 * is admitted. A crash between the commit and the admission leaves the payload here, and the
 * next boot sweep replays it with the SAME deterministic `msg_` id — the host deduplicates on
 * that id, so a replay can never double-deliver. The file is deleted once the host reports the
 * notification admitted (or the session is gone) and whenever a run is cancelled.
 */
export const PENDING_NOTIFICATION_FILE = "pending-notification.json"

/**
 * The reaper's marker on an interrupted run (#136/#175).
 *
 * Orphaning a run writes this file into its directory; the resume sweep renames it to claim the
 * run atomically, and the RPC's `includeHints` poll consumes (reads and deletes) it once. Keeping
 * the name in ONE module is what stops those three surfaces from drifting apart.
 */
export const INTERRUPTED_MARKER = "interrupted.txt"

/**
 * Non-throwing liveness probe for a recorded owner pid.
 *
 * `EPERM` means the process EXISTS but this user may not signal it — alive is the honest answer.
 * `ESRCH` is the definitive dead signal; any other failure reads as dead too, because a pid that
 * cannot be probed must never be treated as a reason to skip reaping forever.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
  }
}

export interface PendingNotification {
  /** The deterministic `msg_ultraopen_outcome_<runId>` / `msg_ultraopen_stop_<runId>` id. */
  id: string
  sessionID: string
  runId: string
  workflow: string
  status: "completed" | "failed"
  /** The settlement's model-facing text, stored verbatim for an idempotent replay. */
  text: string
  /** The one-line description the synthetic transcript entry displays. */
  description: string
}

export function pendingNotificationPath(runId: string, env?: NodeJS.ProcessEnv): string {
  return join(runDir(runId, env), PENDING_NOTIFICATION_FILE)
}

/**
 * Persists the outbox record atomically (temp + rename), so a killed write either leaves the
 * previous payload whole or none, never a torn file the boot sweep would drop.
 *
 * Unlike the readers this can reject: the settlement path decides whether a failed outbox
 * write blocks the notification or merely loses crash durability, and swallowing the error
 * here would hide that choice from it.
 */
export async function writePendingNotification(
  record: PendingNotification,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  if (!isSafeRunId(record.runId)) {throw new Error(`unsafe run id: ${record.runId}`)}
  const path = pendingNotificationPath(record.runId, env)
  await atomicWriteFile(path, JSON.stringify(record, null, 2))
  return path
}

/**
 * Reads one outbox record, tolerating a missing file, a torn write and a wrong-shaped JSON
 * value: a corrupt notification is absent, never a throw that would abort a boot sweep.
 */
export async function readPendingNotification(
  runId: string,
  env?: NodeJS.ProcessEnv,
): Promise<PendingNotification | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(pendingNotificationPath(runId, env), "utf8"))
    return isPendingNotification(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Deletes one outbox record; absent and unremovable files are both no-ops. */
export async function deletePendingNotification(runId: string, env?: NodeJS.ProcessEnv): Promise<void> {
  try {
    await rm(pendingNotificationPath(runId, env), { force: true })
  } catch {
    // Best-effort like the rest of the outbox: a stale file is replayed, not fatal.
  }
}

/**
 * Every surviving outbox record under the run-data root, ordered by run id so a boot sweep's
 * replays are deterministic. Corrupt, foreign and unsafe entries are skipped silently.
 */
export async function listPendingNotifications(env?: NodeJS.ProcessEnv): Promise<PendingNotification[]> {
  const records: PendingNotification[] = []
  for (const runId of await listRunIds(env)) {
    const record = await readPendingNotification(runId, env)
    if (record !== undefined) {records.push(record)}
  }
  return records.toSorted((left, right) => left.runId.localeCompare(right.runId))
}

function isPendingNotification(value: unknown): value is PendingNotification {
  if (typeof value !== "object" || value === null) {return false}
  const record = value as Record<string, unknown>
  return (
    typeof record["id"] === "string" &&
    typeof record["sessionID"] === "string" &&
    typeof record["runId"] === "string" &&
    typeof record["workflow"] === "string" &&
    (record["status"] === "completed" || record["status"] === "failed") &&
    typeof record["text"] === "string" &&
    typeof record["description"] === "string"
  )
}

/**
 * A run id that can never collide with opencode's own artifacts.
 *
 * Rejecting anything unusual outright — rather than sanitising it — keeps a caller-supplied id
 * from ever reaching a path join.
 */
export function isSafeRunId(runId: string): boolean {
  return /^wf_[a-z0-9]{6,}$/u.test(runId)
}

/**
 * Every directory under the run-data root that names a run, sorted for determinism.
 *
 * The listing IS the trust boundary: `readdir` returns whatever is on disk, including opencode's
 * own artifacts and anything a user put there, so the unsafe names are dropped here rather than
 * re-checked by each of the readers below. An unreadable data root lists nothing.
 */
export async function listRunIds(env?: NodeJS.ProcessEnv): Promise<string[]> {
  try {
    const names = await readdir(dataRoot(env))
    return names.filter((name) => isSafeRunId(name)).toSorted()
  } catch {
    return []
  }
}

/**
 * Every readable run manifest under the run-data root, loaded in one parallel pass.
 *
 * Malformed, torn and unsafe entries are skipped by construction: `readManifest` answers
 * `undefined` for anything it cannot parse, and the ids came from {@link listRunIds}.
 */
export async function listManifests(env?: NodeJS.ProcessEnv): Promise<Manifest[]> {
  const runIds = await listRunIds(env),
   manifests = await Promise.all(runIds.map(async (runId) => await readManifest(runId, env)))
  return manifests.filter((manifest): manifest is Manifest => manifest !== undefined)
}

export async function ensureRunDir(runId: string, env?: NodeJS.ProcessEnv): Promise<RunArtifacts> {
  if (!isSafeRunId(runId)) {throw new Error(`unsafe run id: ${runId}`)}
  const paths = artifactPaths(runId, env)
  await mkdir(paths.dir, { recursive: true })
  return paths
}

/**
 * Deletes a run directory entirely, when a launch is proven never to have gone live (#161).
 *
 * The launch manufactures the directory before the permission ask — deliberately, so the user
 * can open the real script while the prompt is on screen — and that pre-ask dir has no manifest
 * when the launch never went live (rejected ask, dry run). No sweep touches it: pruning keys on
 * a manifest, so the dir is a phantom the shared run-data root accumulates one per preview. The
 * launch catch and the dry branch call THIS when the manifest read they already make for the
 * #133 gate proves the run never went live — the same read gates both.
 *
 * Never rejects, like the module's persistence style: the caller reports the launch's outcome
 * in its render, not from the dir's removal. An unsafe id removes nothing — the launch always
 * supplies a minted safe id, so the refusal is the cheap symmetry with ensureRunDir's throw.
 */
export async function removeRunDir(runId: string, env?: NodeJS.ProcessEnv): Promise<void> {
  if (!isSafeRunId(runId)) {return}
  try {
    await rm(runDir(runId, env), { recursive: true, force: true })
  } catch {
    // Best-effort like the writes it rolls back: the dir was never a real run's record.
  }
}

/**
 * Atomic artifact write (#136): temp file + rename.
 *
 * A plain truncate-write killed mid-way leaves a torn file that every reader then swallows — the
 * run vanishes from status, the reaper skips it, its children keep billing. The rename(2) is
 * atomic: a reader either sees the previous file whole or the new file whole, never a tear. The
 * temp name is unique per write, so concurrent writers cannot interleave into one temp; a failed
 * write unlinks its own temp best-effort.
 */
export async function atomicWriteFile(
  path: string,
  body: string,
  /** Test-only fault injection (#136): fail AFTER the temp write, BEFORE the rename — the exact
   * killed-mid-write shape, so tests can prove the previous file survives whole. */
  inject?: { failRename?: boolean } | undefined,
): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, body, "utf8")
    if (inject?.failRename) {
      await unlink(tmp).catch(() => undefined)
      throw new Error("injected rename failure (#136 test seam)")
    }
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export async function writeManifest(
  runId: string,
  manifest: Manifest,
  env?: NodeJS.ProcessEnv,
  /** Test-only fault injection (#136): the killed-write seam discriminates HERE, at the
   * production entry point — a writeManifest regressed to a truncate-write fails this test
   * even though the direct atomicWriteFile tests stay green. */
  inject?: { failRename?: boolean } | undefined,
): Promise<void> {
  const paths = artifactPaths(runId, env)
  await atomicWriteFile(paths.manifestPath, JSON.stringify(manifest, null, 2), inject)
}

export async function writeResult(runId: string, value: unknown, env?: NodeJS.ProcessEnv): Promise<string> {
  const paths = artifactPaths(runId, env)
  await atomicWriteFile(paths.resultPath, JSON.stringify(value, null, 2))
  return paths.resultPath
}

export async function writeScript(runId: string, source: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const paths = artifactPaths(runId, env)
  await atomicWriteFile(paths.scriptPath, source)
  return paths.scriptPath
}

/**
 * Persists a failed run's rendered failure text.
 *
 * In the blocking contract the failure reached the model as the tool result; a
 * detached run outlives that call, so the text must land on disk for the status
 * tool to surface. Best-effort like everything here.
 */
export async function writeFailure(runId: string, text: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const paths = artifactPaths(runId, env)
  await atomicWriteFile(paths.failurePath, text)
  return paths.failurePath
}

/**
 * The three states a manifest read can be in, distinguished (#136).
 *
 * `readManifest` collapses corrupt into missing (its callers treat both as "no manifest"), which
 * is exactly how a torn write made a live run invisible to every surface. The status tool and the
 * reaper use THIS read: corrupt is a distinct, surfaced, quarantinable state.
 */
export type ManifestRead =
  | { state: "missing" }
  | { state: "corrupt"; dir: string }
  | { state: "ok"; manifest: Manifest }

export async function readManifestState(runId: string, env?: NodeJS.ProcessEnv): Promise<ManifestRead> {
  const paths = artifactPaths(runId, env)
  let text: string
  try {
    text = await readFile(paths.manifestPath, "utf8")
  } catch {
    return { state: "missing" }
  }
  try {
    return { state: "ok", manifest: JSON.parse(text) as Manifest }
  } catch {
    return { state: "corrupt", dir: paths.dir }
  }
}

export async function readManifest(runId: string, env?: NodeJS.ProcessEnv): Promise<Manifest | undefined> {
  const read = await readManifestState(runId, env)
  return read.state === "ok" ? read.manifest : undefined
}

export async function appendJournal(runId: string, text: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const paths = artifactPaths(runId, env)
  await writeFile(paths.journalPath, text, "utf8")
}

/**
 * Incremental journal flush: one line per entry as it is recorded, so a process killed mid-run
 * keeps every completed agent. `parseJournal` already tolerates a torn final line — that is the
 * crash mode of a mid-write kill — so a plain append is safe. `appendJournal` still rewrites the
 * full file at endRun, which settles ordering and stays idempotent.
 *
 * This wrapper never rejects: persistence is best-effort by design, and a floating rejection from
 * the tool layer would take down the TUI process.
 */
export async function flushJournalEntry(
  runId: string,
  entry: JournalEntry,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await appendJournalEntry(runId, entry, env)
  } catch {
    // A torn tail otherwise glues the NEXT entry onto the partial line, losing both —
    // rebuild the file from what still parses, then re-append the new entry.
    const entries = await readJournal(runId, env)
    const rebuilt = `${[...entries, entry].map((e) => JSON.stringify(e)).join("\n")}\n`
    await appendJournal(runId, rebuilt, env).catch(() => undefined)
  }
}

export async function appendJournalEntry(
  runId: string,
  entry: JournalEntry,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const paths = artifactPaths(runId, env)
  // A torn tail (mid-write kill or ENOSPC) would glue this entry onto the partial line,
  // losing both on the next parse. Journals are small, so re-establish the newline
  // boundary before appending.
  const existing = await readFile(paths.journalPath, "utf8").catch(() => "")
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n"
  await appendFile(paths.journalPath, `${prefix}${JSON.stringify(entry)}\n`, "utf8")
}

export async function readJournal(runId: string, env?: NodeJS.ProcessEnv): Promise<JournalEntry[]> {
  try {
    const paths = artifactPaths(runId, env)
    return parseJournal(await readFile(paths.journalPath, "utf8"))
  } catch {
    return []
  }
}

/**
 * Finds runs left `running` by a previous process.
 *
 * The parent server never cascades an abort to sessions created with a plain `parentID`, so a
 * process that died mid-run leaves its children alive and billing. `bootId` distinguishes "still
 * running here" from "abandoned by a dead process" — a pid alone would be ambiguous after reuse.
 */
export async function findOrphans(bootId: string, env?: NodeJS.ProcessEnv): Promise<Manifest[]> {
  const orphans: Manifest[] = []
  for (const runId of await listRunIds(env)) {
    const manifest = await readManifest(runId, env)
    if (!manifest) {continue}
    if (manifest.status === "running" && manifest.bootId !== bootId) {orphans.push(manifest)}
  }
  return orphans
}
