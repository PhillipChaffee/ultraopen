import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
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
 * A run id that can never collide with opencode's own artifacts.
 *
 * Rejecting anything unusual outright — rather than sanitising it — keeps a caller-supplied id
 * from ever reaching a path join.
 */
export function isSafeRunId(runId: string): boolean {
  return /^wf_[a-z0-9]{6,}$/u.test(runId)
}

export async function ensureRunDir(runId: string, env?: NodeJS.ProcessEnv): Promise<RunArtifacts> {
  if (!isSafeRunId(runId)) {throw new Error(`unsafe run id: ${runId}`)}
  const paths = artifactPaths(runId, env)
  await mkdir(paths.dir, { recursive: true })
  return paths
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
export async function atomicWriteFile(path: string, body: string): Promise<void> {
  const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, body, "utf8")
    await rename(tmp, path)
  } catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

export async function writeManifest(runId: string, manifest: Manifest, env?: NodeJS.ProcessEnv): Promise<void> {
  const paths = artifactPaths(runId, env)
  await atomicWriteFile(paths.manifestPath, JSON.stringify(manifest, null, 2))
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
  const root = dataRoot(env)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }

  const orphans: Manifest[] = []
  for (const name of names) {
    if (!isSafeRunId(name)) {continue}
    const manifest = await readManifest(name, env)
    if (!manifest) {continue}
    if (manifest.status === "running" && manifest.bootId !== bootId) {orphans.push(manifest)}
  }
  return orphans
}
