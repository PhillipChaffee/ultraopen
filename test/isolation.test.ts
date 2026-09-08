import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { createWorktree, isGitRepository } from "../src/server/bridge/isolation.js"

const run = promisify(execFile)

let repo: string,
 plain: string

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "ultraopen-repo-"))
  plain = await mkdtemp(join(tmpdir(), "ultraopen-plain-"))
  await run("git", ["-C", repo, "init", "-q"])
  await run("git", ["-C", repo, "config", "user.email", "t@example.com"])
  await run("git", ["-C", repo, "config", "user.name", "t"])
  await writeFile(join(repo, "file.txt"), "hello\n")
  await run("git", ["-C", repo, "add", "."])
  await run("git", ["-C", repo, "commit", "-qm", "init"])
})

afterEach(async () => {
  await run("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined)
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

describe("isGitRepository", () => {
  test("recognises a repository and rejects a plain directory", async () => {
    expect(await isGitRepository(repo)).toBe(true)
    expect(await isGitRepository(plain)).toBe(false)
  })
})

describe("createWorktree", () => {
  test("creates a checked-out worktree with the repository's content", async () => {
    // The host's own /experimental/worktree route returns an EMPTY directory because it checks out
    // in a forked fiber — this path is synchronous and fully populated on return.
    const worktree = await createWorktree({ worktreeRoot: repo, label: "agent-a" })
    expect(worktree).toBeDefined()
    expect(await Bun.file(join(worktree?.directory ?? "", "file.txt")).text()).toBe("hello\n")
    await worktree?.release()
  })

  test("creates no branch, so an N-agent phase leaves no refs behind", async () => {
    const worktree = await createWorktree({ worktreeRoot: repo, label: "agent-b" }),
     { stdout } = await run("git", ["-C", repo, "branch", "--list"])
    // --detach: only the original branch exists.
    expect(stdout.split("\n").filter((line) => line.trim() !== "").length).toBe(1)
    await worktree?.release()
  })

  test("degrades with a note when the directory is not a repository", async () => {
    // Isolation is an optimisation for parallel edits; a workflow that cannot have it should still
    // run in place rather than fail.
    const notes: string[] = [],
     worktree = await createWorktree({ worktreeRoot: plain, label: "a", onNote: (note) => notes.push(note) })
    expect(worktree).toBeUndefined()
    expect(notes[0]).toContain("not a git repository")
  })

  test("concurrent creations all succeed despite git's index lock", async () => {
    const worktrees = await Promise.all(
      ["a", "b", "c"].map((label) => createWorktree({ worktreeRoot: repo, label })),
    )
    expect(worktrees.filter(Boolean).length).toBe(3)
    // Distinct directories, so parallel agents cannot clobber each other.
    expect(new Set(worktrees.map((entry) => entry?.directory)).size).toBe(3)
    await Promise.all(worktrees.map((entry) => entry?.release()))
  })

  test("sanitises the label into a safe directory name", async () => {
    const worktree = await createWorktree({ worktreeRoot: repo, label: "verify: jwt/exp <hostile>" })
    expect(worktree?.directory).not.toContain("/verify:")
    expect(worktree?.directory).not.toContain("<")
    await worktree?.release()
  })
})

describe("release", () => {
  test("removes a clean worktree", async () => {
    const worktree = await createWorktree({ worktreeRoot: repo, label: "clean" })
    await worktree?.release()
    const { stdout } = await run("git", ["-C", repo, "worktree", "list"])
    expect(stdout).not.toContain("clean")
  })

  test("RETAINS a dirty worktree and says so", async () => {
    // A dirty worktree holds the agent's uncommitted work — deleting it would silently discard
    // the very output the isolation existed to produce.
    const notes: string[] = [],
     worktree = await createWorktree({ worktreeRoot: repo, label: "dirty", onNote: (note) => notes.push(note) })
    await writeFile(join(worktree?.directory ?? "", "new.txt"), "uncommitted\n")

    await worktree?.release()
    expect(notes.some((note) => note.includes("retained (uncommitted changes)"))).toBe(true)
    expect(await Bun.file(join(worktree?.directory ?? "", "new.txt")).exists()).toBe(true)
    await run("git", ["-C", repo, "worktree", "remove", "--force", worktree?.directory ?? ""]).catch(() => undefined)
  })

  test("reports rather than throws when the worktree is already gone", async () => {
    const notes: string[] = [],
     worktree = await createWorktree({ worktreeRoot: repo, label: "vanish", onNote: (note) => notes.push(note) })
    await rm(worktree?.directory ?? "", { recursive: true, force: true })

    await expect(worktree?.release()).resolves.toBeUndefined()
    expect(notes.some((note) => note.includes("retained (could not read status)"))).toBe(true)
  })
})

describe("creation failure", () => {
  test("degrades with a note when git itself fails", async () => {
    // A repository whose HEAD has no commits cannot produce a worktree. The run should continue in
    // place rather than fail outright.
    const empty = await mkdtemp(join(tmpdir(), "ultraopen-empty-"))
    await run("git", ["-C", empty, "init", "-q"])
    const notes: string[] = [],

     worktree = await createWorktree({ worktreeRoot: empty, label: "a", onNote: (note) => notes.push(note) })
    expect(worktree).toBeUndefined()
    expect(notes.some((note) => note.includes("unavailable"))).toBe(true)

    await rm(empty, { recursive: true, force: true })
  })
})

describe("removal failure", () => {
  test("reports rather than throws when git refuses to remove the worktree", async () => {
    // By cleanup time opencode has an instance loaded on that directory with file watchers holding
    // it, so removal can legitimately fail. Reporting beats failing the run.
    const notes: string[] = [],
     worktree = await createWorktree({ worktreeRoot: repo, label: "stuck", onNote: (note) => notes.push(note) }),

    // Make the worktree's PARENT read-only: `git status` inside still works, but neither git nor
    // rm can delete the directory itself.
     parent = dirname(worktree?.directory ?? "")
    await chmod(parent, 0o500)

    await expect(worktree?.release()).resolves.toBeUndefined()
    await chmod(parent, 0o700)
    expect(notes.some((note) => note.includes("could not be removed"))).toBe(true)
  })
})
