import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultProcessAlive, newBootId, pruneRuns, reapOrphans } from "../src/server/resume/reaper.js"
import { ensureRunDir, readManifest, writeManifest } from "../src/server/resume/store.js"
import type { Manifest } from "../src/server/resume/journal.js"
import type { OpencodeClient } from "../src/server/types.js"

let base: string
let env: NodeJS.ProcessEnv

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  runId: "wf_dead001",
  bootId: "old-boot",
  pid: 999,
  sessionID: "ses_1",
  sourceHash: "s",
  argsHash: "a",
  status: "running",
  childSessionIDs: ["child-1", "child-2"],
  startedAt: 0,
  ...overrides,
})

// Tests must not depend on whether real pids happen to be alive on the host machine.
const DEAD = () => false

const finished = (startedAt: number, endedAt?: number): Partial<Manifest> => ({
  status: "completed",
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
})

function makeClient(abort: (id: string) => Promise<unknown> = () => Promise.resolve({})) {
  const aborted: string[] = []
  const client = {
    session: {
      create: () => Promise.resolve({}),
      get: () => Promise.resolve({}),
      delete: () => Promise.resolve({}),
      abort: (options: { path: { id: string } }) => {
        aborted.push(options.path.id)
        return abort(options.path.id)
      },
      prompt: () => Promise.resolve({}),
    },
  } as unknown as OpencodeClient
  return { client, aborted }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-reap-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
})

afterEach(async () => {
  // Restore write permission before cleanup: one test makes a run directory read-only.
  await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_dead001", "manifest.json"), 0o600).catch(
    () => undefined,
  )
  await rm(base, { recursive: true, force: true })
})

describe("newBootId", () => {
  test("identifies the process and is stable within it", () => {
    expect(newBootId()).toBe(newBootId())
    expect(newBootId()).toContain(String(process.pid))
  })
})

describe("reapOrphans", () => {
  const seed = async (overrides: Partial<Manifest> = {}): Promise<void> => {
    const entry = manifest(overrides)
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
  }

  test("aborts every child of a run abandoned by a dead process", async () => {
    // opencode never cascades an abort to plain parentID children, so without this they keep
    // running — and billing — after the server that started them is gone.
    await seed()
    const { client, aborted } = makeClient()

    const result = await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })
    expect(aborted).toEqual(["child-1", "child-2"])
    expect(result).toEqual({ runs: 1, sessions: 2, failures: 0, live: 0 })
  })

  test("marks the run orphaned so a later start does not sweep it again", async () => {
    await seed()
    const { client } = makeClient()
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })

    expect((await readManifest("wf_dead001", env))?.status).toBe("orphaned")

    const second = makeClient()
    expect(await reapOrphans(second.client, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
    })
    expect(second.aborted).toEqual([])
  })

  test("skips a run whose owning process is still alive", async () => {
    // Several opencode instances share one data root. A fresh boot id must not condemn another
    // live process's run — that would abort workflows that are working correctly.
    await seed()
    const { client, aborted } = makeClient()
    const notes: string[] = []

    const result = await reapOrphans(client, "current-boot", {
      env,
      isProcessAlive: () => true,
      onNote: (note) => notes.push(note),
    })
    expect(aborted).toEqual([])
    expect(result).toEqual({ runs: 0, sessions: 0, failures: 0, live: 1 })
    expect((await readManifest("wf_dead001", env))?.status).toBe("running")
    // The skip is visible rather than silent.
    expect(notes[0]).toContain("still alive")
  })

  test("defaultProcessAlive treats an out-of-range pid as dead", () => {
    // 2**31 - 2 exceeds every platform's pid ceiling, so the probe answers ESRCH, not EPERM.
    expect(defaultProcessAlive(2 ** 31 - 2)).toBe(false)
  })

  test("leaves runs from the CURRENT boot alone", async () => {
    // Those are live, and aborting them would kill a workflow that is working correctly.
    await seed({ bootId: "current-boot" })
    const { client, aborted } = makeClient()

    expect(await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
    })
    expect(aborted).toEqual([])
  })

  test("counts aborts that fail and still marks the run orphaned", async () => {
    // A session may already be gone. The run is lost either way; the point is to stop it costing
    // money, not to insist every abort lands.
    await seed()
    const { client } = makeClient((id) => (id === "child-1" ? Promise.reject(new Error("gone")) : Promise.resolve({})))

    const result = await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })
    expect(result).toEqual({ runs: 1, sessions: 1, failures: 1, live: 0 })
    expect((await readManifest("wf_dead001", env))?.status).toBe("orphaned")
  })

  test("reports what it released", async () => {
    await seed()
    const notes: string[] = []
    const { client } = makeClient()
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })

    expect(notes[0]).toContain("released 2 subagent session(s)")
    expect(notes[0]).toContain("1 interrupted run(s)")
  })

  test("mentions failures in the note", async () => {
    await seed()
    const notes: string[] = []
    const { client } = makeClient(() => Promise.reject(new Error("gone")))
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })

    expect(notes[0]).toContain("2 could not be aborted")
  })

  test("stays silent and cheap when there is nothing to reap", async () => {
    const notes: string[] = []
    const { client } = makeClient()
    expect(await reapOrphans(client, "boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
    })
    expect(notes).toEqual([])
  })

  test("a run with no recorded children is still marked orphaned", async () => {
    await seed({ childSessionIDs: [] })
    const { client } = makeClient()
    expect(await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 1,
      sessions: 0,
      failures: 0,
      live: 0,
    })
  })
})

describe("failure tolerance", () => {
  test("an unreadable data root reaps nothing instead of throwing at startup", async () => {
    // The sweep runs during plugin init. A broken data directory must not take down the plugin.
    const notADirectory = join(base, "file.txt")
    await Bun.write(notADirectory, "x")
    const { client } = makeClient()

    expect(
      await reapOrphans(client, "boot", { env: { XDG_DATA_HOME: notADirectory } as NodeJS.ProcessEnv }),
    ).toEqual({ runs: 0, sessions: 0, failures: 0, live: 0 })
  })

  test("a manifest that cannot be rewritten still counts the aborts it managed", async () => {
    const entry = manifest()
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    // Make the manifest FILE read-only. Directory permissions would not be enough — overwriting
    // an existing file only needs write permission on the file itself.
    await chmod(join(base, "opencode", "tool-output", "ultraopen", entry.runId, "manifest.json"), 0o400)

    const { client, aborted } = makeClient()
    const result = await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })

    expect(aborted).toEqual(["child-1", "child-2"])
    expect(result.sessions).toBe(2)
  })
})

describe("non-throwing contract", () => {
  test("never rejects, so callers can fire-and-forget without a handler", async () => {
    // index.ts relies on this: it starts the sweep during plugin init with no .catch(), because an
    // unreachable handler there would be untestable defensive code.
    const entry = manifest()
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    await chmod(join(base, "opencode", "tool-output", "ultraopen", entry.runId, "manifest.json"), 0o400)

    const { client } = makeClient(() => Promise.reject(new Error("everything is broken")))
    await expect(reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })).resolves.toBeDefined()
  })
})

describe("pruneRuns", () => {
  test("deletes finished runs past the retention window and keeps everything else", async () => {
    // Old enough to be pruned no matter when the test runs.
    const ancient = 0
    const seed = async (runId: string, overrides: Partial<Manifest>): Promise<void> => {
      await ensureRunDir(runId, env)
      await writeManifest(runId, manifest({ runId, ...overrides }), env)
    }
    await seed("wf_ancient1", { runId: "wf_ancient1", ...finished(ancient) })
    await seed("wf_fresh01", { runId: "wf_fresh01", status: "completed", startedAt: Date.now() })
    await seed("wf_liverun", { runId: "wf_liverun", status: "running", startedAt: ancient })

    const pruned = await pruneRuns({ env, now: Date.now() })
    expect(pruned).toBe(1)
    expect(await readManifest("wf_ancient1", env)).toBeUndefined()
    expect(await readManifest("wf_fresh01", env)).toBeDefined()
    // A live run must never lose its journal, however old it is.
    expect(await readManifest("wf_liverun", env)).toBeDefined()
  })

  test("never rejects, so callers can fire-and-forget without a handler", async () => {
    const broken = join(base, "not-a-dir")
    await expect(pruneRuns({ env: { XDG_DATA_HOME: broken } as NodeJS.ProcessEnv })).resolves.toBe(0)
  })
})
