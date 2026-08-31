import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * Git worktrees for `isolation: "worktree"`.
 *
 * Created with `git worktree add --detach` via node:child_process, NOT through opencode's own
 * `/experimental/worktree` route. That route creates with `--no-checkout` and populates in a forked
 * fiber, so the response returns an EMPTY directory; it has no detached option, so it leaks a
 * branch per agent; and it runs the project's start command in every worktree, which for an
 * N-agent phase means N dev servers.
 *
 * `input.$` is deliberately unused: it is undefined whenever `typeof Bun === "undefined"`, and
 * opencode ships a Node build.
 */

export type Worktree = {
  directory: string
  /** Removes the worktree. Non-fatal on failure — see remove(). */
  release: () => Promise<void>
}

export type WorktreeOptions = {
  /** Repository root to branch from. */
  worktreeRoot: string
  /** Distinguishes concurrent worktrees within a run. */
  label: string
  onNote?: ((note: string) => void) | undefined
}

/**
 * Serialises creation: concurrent `git worktree add` calls race git's index lock.
 *
 * Only ever assigned a promise settled by its own `resolve()`, so awaiting it cannot reject.
 */
let creating: Promise<void> = Promise.resolve()

export async function isGitRepository(directory: string): Promise<boolean> {
  try {
    await run("git", ["-C", directory, "rev-parse", "--git-dir"])
    return true
  } catch {
    return false
  }
}

/**
 * Creates an isolated worktree.
 *
 * Returns undefined rather than throwing when the directory is not a git repository — isolation is
 * an optimisation for parallel file edits, and a workflow that cannot have it should still run in
 * place rather than fail.
 */
export async function createWorktree(options: WorktreeOptions): Promise<Worktree | undefined> {
  if (!(await isGitRepository(options.worktreeRoot))) {
    options.onNote?.(`isolation: "worktree" ignored — ${options.worktreeRoot} is not a git repository`)
    return undefined
  }

  const previous = creating
  let signalDone: (() => void) | undefined
  creating = new Promise<void>((resolve) => {
    signalDone = resolve
  })

  try {
    // No .catch(): the queue promise is only ever settled by its own resolve(), so it cannot
    // reject, and an unreachable handler here would be untestable defensive code.
    await previous
    const base = await mkdtemp(join(tmpdir(), "ultraopen-wt-"))
    const directory = join(base, options.label.replaceAll(/[^\w.-]/gu, "-").slice(0, 40) || "agent")

    // --detach avoids creating a branch per agent, which would otherwise accumulate and need
    // cleaning up separately from the worktree itself.
    await run("git", ["-C", options.worktreeRoot, "worktree", "add", "--detach", directory, "HEAD"])

    return {
      directory,
      release: async () => {
        await removeWorktree(options.worktreeRoot, directory, base, options.onNote)
      },
    }
  } catch (error) {
    options.onNote?.(`isolation: "worktree" unavailable — ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  } finally {
    signalDone?.()
  }
}

/**
 * Removes a worktree, but only when it is clean.
 *
 * A dirty worktree holds the agent's uncommitted work. Deleting it would silently discard the very
 * output the isolation existed to produce, so it is retained and reported instead.
 */
async function removeWorktree(
  worktreeRoot: string,
  directory: string,
  base: string,
  onNote?: ((note: string) => void) | undefined,
): Promise<void> {
  try {
    const { stdout } = await run("git", ["-C", directory, "status", "--porcelain"])
    if (stdout.trim() !== "") {
      onNote?.(`worktree retained (uncommitted changes): ${directory}`)
      return
    }
  } catch {
    onNote?.(`worktree retained (could not read status): ${directory}`)
    return
  }

  try {
    await run("git", ["-C", worktreeRoot, "worktree", "remove", "--force", directory])
    await rm(base, { recursive: true, force: true })
  } catch {
    // Non-fatal: by cleanup time opencode has an instance loaded on that directory with file
    // watchers holding it, so removal can legitimately fail. Reporting beats failing the run.
    onNote?.(`worktree could not be removed, left in place: ${directory}`)
  }
}
