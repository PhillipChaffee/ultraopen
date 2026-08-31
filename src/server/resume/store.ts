import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseJournal, type JournalEntry, type Manifest } from "./journal.js"

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
  const xdg = env["XDG_DATA_HOME"]
  const base = xdg && xdg.trim() !== "" ? xdg : join(homedir(), ".local", "share")
  return join(base, "opencode", "tool-output", NAMESPACE)
}

export function runDir(runId: string, env?: NodeJS.ProcessEnv): string {
  return join(dataRoot(env), runId)
}

export type RunArtifacts = {
  dir: string
  journalPath: string
  manifestPath: string
  resultPath: string
  scriptPath: string
}

export function artifactPaths(runId: string, env?: NodeJS.ProcessEnv): RunArtifacts {
  const dir = runDir(runId, env)
  return {
    dir,
    journalPath: join(dir, "journal.jsonl"),
    manifestPath: join(dir, "manifest.json"),
    resultPath: join(dir, "result.json"),
    scriptPath: join(dir, "script.js"),
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
  if (!isSafeRunId(runId)) throw new Error(`unsafe run id: ${runId}`)
  const paths = artifactPaths(runId, env)
  await mkdir(paths.dir, { recursive: true })
  return paths
}

export async function writeManifest(runId: string, manifest: Manifest, env?: NodeJS.ProcessEnv): Promise<void> {
  const paths = artifactPaths(runId, env)
  await writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), "utf8")
}

export async function readManifest(runId: string, env?: NodeJS.ProcessEnv): Promise<Manifest | undefined> {
  try {
    const paths = artifactPaths(runId, env)
    return JSON.parse(await readFile(paths.manifestPath, "utf8")) as Manifest
  } catch {
    return undefined
  }
}

export async function appendJournal(runId: string, text: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const paths = artifactPaths(runId, env)
  await writeFile(paths.journalPath, text, "utf8")
}

export async function readJournal(runId: string, env?: NodeJS.ProcessEnv): Promise<JournalEntry[]> {
  try {
    const paths = artifactPaths(runId, env)
    return parseJournal(await readFile(paths.journalPath, "utf8"))
  } catch {
    return []
  }
}

export async function writeResult(runId: string, value: unknown, env?: NodeJS.ProcessEnv): Promise<string> {
  const paths = artifactPaths(runId, env)
  await writeFile(paths.resultPath, JSON.stringify(value, null, 2), "utf8")
  return paths.resultPath
}

export async function writeScript(runId: string, source: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const paths = artifactPaths(runId, env)
  await writeFile(paths.scriptPath, source, "utf8")
  return paths.scriptPath
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
    if (!isSafeRunId(name)) continue
    const manifest = await readManifest(name, env)
    if (!manifest) continue
    if (manifest.status === "running" && manifest.bootId !== bootId) orphans.push(manifest)
  }
  return orphans
}
