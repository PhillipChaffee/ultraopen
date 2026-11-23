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
  /**
   * The project's canonical checkout (#175). A session in a git worktree still resolves the
   * workflows saved in the canonical tree; the worktree's own copy wins a collision.
   */
  canonicalDirectory?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  readDir?: ((path: string) => Promise<string[]>) | undefined
  readFile?: ((path: string) => Promise<string>) | undefined
  onNote?: ((note: string) => void) | undefined
}

/**
 * The user-level directory: inside the opencode configuration directory.
 *
 * Precedence is V2's own: an explicit `OPENCODE_CONFIG_DIR` (tests, hosts that move the config
 * root) > `XDG_CONFIG_HOME/opencode` > `~/.config/opencode`. Honoring only the legacy variable
 * made a saved workflow invisible on a host that sets just `XDG_CONFIG_HOME`; blank values
 * count as unset rather than resolving a path off the filesystem root.
 */
export function userWorkflowDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env["OPENCODE_CONFIG_DIR"]?.trim(),
   xdg = env["XDG_CONFIG_HOME"]?.trim()
  let configDir = join(homedir(), ".config", "opencode")
  if (xdg !== undefined && xdg !== "") {configDir = join(xdg, "opencode")}
  if (explicit !== undefined && explicit !== "") {configDir = explicit}
  return join(configDir, "ultraopen", "workflows")
}

/** The project-level directory, present only when a project directory is known. */
export function projectWorkflowDir(directory: string | undefined): string | undefined {
  return directory ? join(directory, ".opencode", "ultraopen", "workflows") : undefined
}

/**
 * Every configured directory, in scan order: user, custom, canonical project, worktree project.
 *
 * Later entries overwrite earlier ones in the returned map, so the worktree project — the most
 * specific to what the session is editing — is the strongest, with the canonical checkout as
 * its fallback. The canonical directory is scanned only when it differs from the worktree
 * directory, so a session running in the canonical checkout does not scan it twice. Relative
 * custom paths resolve against the worktree directory when there is one, else the canonical.
 */
export function workflowDirectories(options: NamedOptions = {}): string[] {
  const env = options.env ?? process.env,
   project = options.directory === undefined ? undefined : resolve(options.directory),
   canonical = options.canonicalDirectory === undefined ? undefined : resolve(options.canonicalDirectory),
   base = project ?? canonical,
   canonicalDir = canonical === undefined ? undefined : projectWorkflowDir(canonical),
   projectDir = project === undefined ? undefined : projectWorkflowDir(project)

  const dirs = [userWorkflowDir(env)]
  for (const path of options.workflowPaths ?? []) {
    dirs.push(base !== undefined && !isAbsoluteish(path) ? join(base, path) : path)
  }
  if (canonicalDir !== undefined && canonicalDir !== projectDir) {dirs.push(canonicalDir)}
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

/** One saved workflow as the command surface names it. */
export interface SavedWorkflow {
  readonly name: string
  readonly description: string | undefined
  /** The file's source, so a same-named edit still refreshes the command surface. */
  readonly source: string
}

/**
 * Parses the asynchronously scanned sources into the command surface's entries.
 *
 * The scan validates every file with the same `parse` the engine runs, so a source here is
 * expected to parse; a file that stopped parsing between the scan and this pass loses its command
 * rather than taking the plugin load down. The run path notes the skip when the tool asks for it.
 */
export function parseSavedWorkflows(named: Record<string, string>): SavedWorkflow[] {
  const entries: SavedWorkflow[] = []
  for (const [name, source] of Object.entries(named)) {
    try {
      entries.push({ name, description: parse(source).meta.description, source })
    } catch {
      // A broken save loses its command until it parses; the run path notes the skip.
    }
  }
  return entries
}
