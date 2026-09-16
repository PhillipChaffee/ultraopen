import { readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { parse } from "../script/parse.js"

/**
 * Saved workflows: named scripts the tool resolves from disk.
 *
 * A directory holds one script per file; the file name without its extension is
 * the workflow name. The scan happens per tool call rather than once at load, so
 * a file saved mid-session is usable at once and no in-memory map can drift from
 * disk. A saved file that fails to parse is skipped with a note — a broken file
 * in the directory must never take the tool down, and it must never block the
 * plugin load either, which is why the scan is per call.
 *
 * Resolution order, strongest last: the user directory, the configured custom
 * paths, the project directory. The project wins on a name collision because it
 * is the most specific to what the user is working on.
 */

/** Files scanned per call. A directory bigger than this is truncated, loudly. */
export const MAX_SCAN_FILES = 200

/** Extensions treated as workflow scripts; the name is the file name minus one of these. */
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".ts"]

export interface NamedOptions {
  /** Custom workflow directories from the `workflowPaths` option. */
  workflowPaths?: readonly string[] | undefined
  /** The project directory the session is running in; its `.opencode/ultraopen/workflows` wins. */
  directory?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  readDir?: ((path: string) => Promise<string[]>) | undefined
  readFile?: ((path: string) => Promise<string>) | undefined
  onNote?: ((note: string) => void) | undefined
}

/** The user-level directory: inside the opencode configuration directory. */
export function userWorkflowDir(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env["OPENCODE_CONFIG_DIR"]?.trim() || join(homedir(), ".config", "opencode")
  return join(configDir, "ultraopen", "workflows")
}

/** The project-level directory, present only when a project directory is known. */
export function projectWorkflowDir(directory: string | undefined): string | undefined {
  return directory ? join(directory, ".opencode", "ultraopen", "workflows") : undefined
}

/**
 * Every configured directory, in scan order: user, custom, project.
 *
 * Later entries overwrite earlier ones in the returned map, so the project is
 * the strongest. Relative custom paths resolve against the project directory.
 */
export function workflowDirectories(options: NamedOptions = {}): string[] {
  const env = options.env ?? process.env,
   project = options.directory === undefined ? undefined : resolve(options.directory),
   projectDir = project === undefined ? undefined : projectWorkflowDir(project)

  const dirs = [userWorkflowDir(env)]
  for (const path of options.workflowPaths ?? []) {
    dirs.push(project !== undefined && !isAbsoluteish(path) ? join(project, path) : path)
  }
  if (projectDir !== undefined) {dirs.push(projectDir)}
  return dirs
}

function isAbsoluteish(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[/\\]/u.test(path)
}

/**
 * Reads the configured directories and maps each workflow name to its source.
 *
 * Never rejects and never throws from a missing directory: the plugin load and
 * every tool call must survive a misconfigured path. `onNote` names skipped
 * files so a broken save explains itself in the run log instead of vanishing.
 */
export async function scanNamedWorkflows(options: NamedOptions = {}): Promise<Record<string, string>> {
  const readDir = options.readDir ?? defaultReadDir,
   readFile = options.readFile ?? defaultReadFile,
   named: Record<string, string> = {}

  let scanned = 0
  for (const dir of workflowDirectories(options)) {
    let names: string[]
    try {
      names = await readDir(dir)
    } catch {
      continue
    }

    for (const fileName of names) {
      const name = stripExtension(fileName)
      if (name === undefined) {continue}
      if (scanned >= MAX_SCAN_FILES) {
        options.onNote?.(`workflow directory scan capped at ${MAX_SCAN_FILES} files; some saved workflows were not loaded`)
        return named
      }
      scanned++
      try {
        const source = await readFile(join(dir, fileName))
        // Validation is the same parse the engine runs: a file that cannot
        // parse, or holds no valid meta block, is skipped and named in a note.
        parse(source)
        named[name] = source
      } catch (error) {
        options.onNote?.(`saved workflow "${fileName}" was skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return named
}

/**
 * The workflow name from a file name, or undefined for non-script files.
 *
 * `.ts`/`.mjs` are checked before `.js` so `foo.mjs` does not lose only its `s`.
 */
function stripExtension(fileName: string): string | undefined {
  for (const extension of SCRIPT_EXTENSIONS) {
    if (fileName.toLowerCase().endsWith(extension)) {
      const name = fileName.slice(0, -extension.length)
      // The name must stay a bare name: it is looked up as a string key and
      // never used as a path here, but a separator in it would be a lie about
      // what a saved workflow is.
      return name === "" || name.includes("/") || name.includes("\\") ? undefined : name
    }
  }
  return undefined
}

async function defaultReadDir(path: string): Promise<string[]> {
  const fs = await import("node:fs/promises")
  return await fs.readdir(path)
}

async function defaultReadFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises")
  return await fs.readFile(path, "utf8")
}
/**
 * Loads every saved workflow synchronously, with its meta description.
 *
 * Used by the plugin's config hook, which is synchronous by contract — anything
 * awaited there would be discarded. The per-call scan above stays async and is
 * the source of truth for RUNS; this listing is only what the /workflow-…
 * commands are built from at load, so a file saved mid-session gains its command
 * on the next start (its RUN is usable at once).
 */
export function listSavedWorkflows(options: NamedOptions = {}): { name: string; description: string | undefined }[] {
  const out: { name: string; description: string | undefined }[] = [],
   dirs = workflowDirectories(options)

  let scanned = 0
  for (const dir of dirs) {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const fileName of names) {
      const name = stripExtension(fileName)
      if (name === undefined) {continue}
      if (scanned >= MAX_SCAN_FILES) {return out}
      scanned++
      try {
        const parsed = parse(readFileSync(join(dir, fileName), "utf8"))
        out.push({ name, description: parsed.meta.description })
      } catch {
        // A broken save loses its command until it parses; the per-call scan
        // will note the skip every time the tool runs.
      }
    }
  }
  return out
}
