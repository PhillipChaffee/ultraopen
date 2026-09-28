import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultProcessAlive, newBootId, pruneRuns, reapOrphans, salvagePid } from "../src/server/resume/reaper.js"
import { ensureRunDir, readManifest, readManifestState, writeManifest } from "../src/server/resume/store.js"
import type { Manifest } from "../src/server/resume/journal.js"
import type { OpencodeClient } from "../src/server/types.js"

let base: string,
 env: NodeJS.ProcessEnv

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
}),

// Tests must not depend on whether real pids happen to be alive on the host machine.
 DEAD = () => false,

 finished = (startedAt: number, endedAt?: number): Partial<Manifest> => ({
  status: "completed",
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
})

function makeClient(abort: (id: string) => Promise<unknown> = () => Promise.resolve({})) {
  const aborted: string[] = [],
   client = {
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
  // Restore write permission before cleanup: tests make run DIRECTORIES read-only (atomic
  // writes are blocked by the directory), and rm needs the write back.
  await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_dead001"), 0o700).catch(
    () => undefined,
  )
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
  const seed = async (overrides: Partial<Manifest> = {}): Promise<Manifest> => {
    const entry = manifest(overrides)
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    return entry
  }

  test("aborts every child of a run abandoned by a dead process", async () => {
    // opencode never cascades an abort to plain parentID children, so without this they keep
    // running — and billing — after the server that started them is gone.
    const entry = await seed()
    const { client, aborted } = makeClient(),

     result = await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })
    expect(aborted).toEqual(["child-1", "child-2"])
    expect(result).toEqual({ runs: 1, sessions: 2, failures: 0, live: 0, orphaned: [entry] })
  })

  test("leaves an interrupted marker the TUI reads, so the next start hints", async () => {
    const { client } = makeClient()
    const entry = await seed({ pid: 424_242 })
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })
    const marker = await readFile(join(env["XDG_DATA_HOME"] ?? "", "opencode", "tool-output", "ultraopen", entry.runId, "interrupted.txt"), "utf8")
    expect(marker).toBe(entry.runId)
  })

  test("a run skipped for a live owner leaves no marker", async () => {
    const { client } = makeClient()
    await seed({ pid: 424_242 })
    await reapOrphans(client, "current-boot", { env, isProcessAlive: () => true })
    const markerPath = join(env["XDG_DATA_HOME"] ?? "", "opencode", "tool-output", "ultraopen")
    // No directory holds a marker: nothing was reaped.
    const dirs = await readdir(markerPath).catch((): string[] => [])
    let markers = 0
    for (const name of dirs) {
      const files = await readdir(join(markerPath, name)).catch((): string[] => [])
      if (files.includes("interrupted.txt")) {markers++}
    }
    expect(markers).toBe(0)
  })

  test("marks the run orphaned so a later start does not sweep it again", async () => {
    await seed()
    const { client } = makeClient()
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })

    const orphanManifest = await readManifest("wf_dead001", env)
    expect(orphanManifest?.status).toBe("orphaned")

    const second = makeClient()
    expect(await reapOrphans(second.client, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
    expect(second.aborted).toEqual([])
  })

  test("stamps the moment the run became a pending resume decision", async () => {
    // The orphan stamp starts the auto-resume window and the prune window alike, so it must be
    // the orphaning moment — not the epoch placeholder, which would expire every run instantly.
    await seed()
    const { client } = makeClient(),
      before = Date.now()
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })

    const orphanManifest = await readManifest("wf_dead001", env)
    expect(orphanManifest?.endedAt).toBeGreaterThanOrEqual(before)
    expect(orphanManifest?.endedAt ?? 0).toBeLessThanOrEqual(Date.now())
  })

  test("skips a run whose owning process is still alive", async () => {
    // Several opencode instances share one data root. A fresh boot id must not condemn another
    // live process's run — that would abort workflows that are working correctly.
    await seed()
    const { client, aborted } = makeClient(),
     notes: string[] = [],

     result = await reapOrphans(client, "current-boot", {
      env,
      isProcessAlive: () => true,
      onNote: (note) => notes.push(note),
    })
    expect(aborted).toEqual([])
    expect(result).toEqual({ runs: 0, sessions: 0, failures: 0, live: 1, orphaned: [] })
    const orphanManifest = await readManifest("wf_dead001", env)
    expect(orphanManifest?.status).toBe("running")
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
      orphaned: [],
    })
    expect(aborted).toEqual([])
  })

  test("counts aborts that fail and still marks the run orphaned", async () => {
    // A session may already be gone. The run is lost either way; the point is to stop it costing
    // money, not to insist every abort lands.
    const entry = await seed()
    const { client } = makeClient((id) => (id === "child-1" ? Promise.reject(new Error("gone")) : Promise.resolve({}))),

     result = await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })
    expect(result).toEqual({ runs: 1, sessions: 1, failures: 1, live: 0, orphaned: [entry] })
    const orphanManifest = await readManifest("wf_dead001", env)
    expect(orphanManifest?.status).toBe("orphaned")
  })

  test("reports what it released", async () => {
    await seed()
    const notes: string[] = [],
     { client } = makeClient()
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })

    expect(notes[0]).toContain("released 2 subagent session(s)")
    expect(notes[0]).toContain("1 interrupted run(s)")
  })

  test("mentions failures in the note", async () => {
    await seed()
    const notes: string[] = [],
     { client } = makeClient(() => Promise.reject(new Error("gone")))
    await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })

    expect(notes[0]).toContain("2 could not be aborted")
  })

  test("stays silent and cheap when there is nothing to reap", async () => {
    const notes: string[] = [],
     { client } = makeClient()
    expect(await reapOrphans(client, "boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
    expect(notes).toEqual([])
  })

  test("a run with no recorded children is still marked orphaned", async () => {
    const entry = await seed({ childSessionIDs: [] })
    const { client } = makeClient()
    expect(await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 1,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [entry],
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
    ).toEqual({ runs: 0, sessions: 0, failures: 0, live: 0, orphaned: [] })
  })

  test("a manifest that cannot be rewritten still counts the aborts it managed", async () => {
    const entry = manifest()
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    // Atomic writes (#136) rename over the target, so the DIRECTORY permission is what blocks
    // the write: an unwritable run dir makes the tombstone write fail while aborts still land.
    await chmod(join(base, "opencode", "tool-output", "ultraopen", entry.runId), 0o500)

    const { client, aborted } = makeClient(),
     result = await reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })

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
    await chmod(join(base, "opencode", "tool-output", "ultraopen", entry.runId), 0o500)

    const { client } = makeClient(() => Promise.reject(new Error("everything is broken")))
    await expect(reapOrphans(client, "current-boot", { env, isProcessAlive: DEAD })).resolves.toBeDefined()
  })
})

describe("pruneRuns", () => {
  test("deletes finished runs past the retention window and keeps everything else", async () => {
    // Old enough to be pruned no matter when the test runs.
    const ancient = 0,
     seed = async (runId: string, overrides: Partial<Manifest>): Promise<void> => {
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

  test("an orphaned run inside the resume window survives pruning", async () => {
    // An orphaned run is an unanswered resume decision, not waste: this one is old enough to be
    // retention-prunable, but its interruption is 2 days old and the sweep window is 7 days.
    const now = Date.now(),
     day = 24 * 60 * 60 * 1000,
     seed = async (runId: string, overrides: Partial<Manifest>): Promise<void> => {
       await ensureRunDir(runId, env)
       await writeManifest(runId, manifest({ runId, ...overrides }), env)
     }
    await seed("wf_orphyng", { runId: "wf_orphyng", status: "orphaned", startedAt: now - 40 * day, endedAt: now - 2 * day })
    await seed("wf_orphold", { runId: "wf_orphold", status: "orphaned", startedAt: now - 40 * day, endedAt: now - 40 * day })
    await seed("wf_doneold", { runId: "wf_doneold", status: "completed", startedAt: now - 40 * day, endedAt: now - 40 * day })

    const pruned = await pruneRuns({ env, now, autoResumeTtlHours: 24 * 7 })
    // The young orphan survives its pending-decision window; the window-expired orphan and the
    // terminal run prune like waste.
    expect(pruned).toBe(2)
    expect(await readManifest("wf_orphyng", env)).toBeDefined()
    expect(await readManifest("wf_orphold", env)).toBeUndefined()
    expect(await readManifest("wf_doneold", env)).toBeUndefined()
  })

  test("never rejects, so callers can fire-and-forget without a handler", async () => {
    const broken = join(base, "not-a-dir")
    await expect(pruneRuns({ env: { XDG_DATA_HOME: broken } as NodeJS.ProcessEnv })).resolves.toBe(0)
  })
})

test("a run with an unreadable manifest is quarantined, not skipped (#136)", async () => {
  const { manifestPath } = await ensureRunDir("wf_dead001", env)
  await writeFile(manifestPath, "{torn", "utf8")
  const { client } = makeClient()
  const result = await reapOrphans(client, "fresh-boot", { env, isProcessAlive: DEAD })
  expect(result.runs).toBe(1)
  const m = await readManifest("wf_dead001", env)
  expect(m?.status).toBe("orphaned")
  const pruned = await pruneRuns({ env, now: Date.now() + 31 * 24 * 60 * 60 * 1000, autoResumeTtlHours: 24 })
  expect(pruned).toBe(1)
})

describe("quarantine respects the live-pid veto (#136 review)", () => {
  const seedTorn = async (body: string, runId = "wf_dead001"): Promise<void> => {
    const { manifestPath } = await ensureRunDir(runId, env)
    await writeFile(manifestPath, body, "utf8")
  }

  test("a torn manifest whose pid is salvageable and alive is left untouched — no tombstone, no marker", async () => {
    // The veto the orphan pass applies to readable manifests must apply to torn ones too: a
    // live owner (mid-write-recovery in a concurrent process) would find its settlement
    // permanently blocked by a tombstone — endRun refuses any non-running status — and its
    // dir would wear an interrupted marker while it is still working.
    await seedTorn('{\n  "runId": "wf_dead001",\n  "bootId": "old-boot",\n  "pid": 4242,')
    const { client } = makeClient()
    expect(await reapOrphans(client, "fresh-boot", { env, isProcessAlive: () => true })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 1,
      orphaned: [],
    })
    const tornState = await readManifestState("wf_dead001", env)
    expect(tornState.state).toBe("corrupt")
    const files = await readdir(join(base, "opencode", "tool-output", "ultraopen", "wf_dead001"))
    expect(files).not.toContain("interrupted.txt")
  })

  test("a torn manifest whose salvaged pid is dead is still quarantined", async () => {
    await seedTorn('{\n  "runId": "wf_dead001",\n  "bootId": "old-boot",\n  "pid": 4242,')
    const { client } = makeClient()
    expect(await reapOrphans(client, "fresh-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 1,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
    const settled = await readManifest("wf_dead001", env)
    expect(settled?.status).toBe("orphaned")
  })

  test("no salvageable pid means no veto — the same rule as the orphan pass with a missing pid", async () => {
    await seedTorn("{torn")
    const { client } = makeClient()
    expect(await reapOrphans(client, "fresh-boot", { env, isProcessAlive: () => true })).toEqual({
      runs: 1,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
  })

  test("the veto rides the default process probe too", async () => {
    // This test's own process is alive, so the un-injected probe must veto — no isProcessAlive.
    await seedTorn(`{\n  "runId": "wf_dead001",\n  "pid": ${String(process.pid)},`)
    const { client } = makeClient()
    const probed = await reapOrphans(client, "fresh-boot", { env })
    expect(probed.live).toBe(1)
    const stillTorn = await readManifestState("wf_dead001", env)
    expect(stillTorn.state).toBe("corrupt")
  })

  test("a salvageable-but-impossible pid (overflow) is no veto", async () => {
    await seedTorn(`{\n  "pid": ${"9".repeat(400)},`)
    const { client } = makeClient()
    const overflowResult = await reapOrphans(client, "fresh-boot", { env, isProcessAlive: () => true })
    expect(overflowResult.runs).toBe(1)
  })

  test("a quarantine veto surfaces in the same live-skip accounting as an orphan-pass skip", async () => {
    // One readable live orphan plus one vetoed torn run: both skip for the same reason, so the
    // result must count both and the note must say so — the skip is visible, never silent.
    await seedTorn('{\n  "runId": "wf_torn001",\n  "pid": 4242,', "wf_torn001")
    await ensureRunDir("wf_dead001", env)
    await writeManifest("wf_dead001", manifest({ pid: 424_242 }), env)
    const notes: string[] = [],
      { client } = makeClient()
    expect(await reapOrphans(client, "fresh-boot", { env, isProcessAlive: () => true, onNote: (note) => notes.push(note) })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 2,
      orphaned: [],
    })
    expect(notes[0]).toContain("2 run(s) skipped")
    expect(notes[0]).toContain("still alive")
  })
})

describe("salvagePid", () => {
  test("reads the pid out of torn manifest text; absent or malformed pids salvage to nothing", () => {
    expect(salvagePid('{\n  "runId": "wf_x",\n  "bootId": "b",\n  "pid": 4242,')).toBe(4242)
    expect(salvagePid("{torn")).toBeUndefined()
    expect(salvagePid(undefined)).toBeUndefined()
    expect(salvagePid('{"pid": NaN}')).toBeUndefined()
    expect(salvagePid(`{"pid": ${"9".repeat(400)}}`)).toBeUndefined()
  })
})

test("an unexpected failure inside the sweep returns the zero result instead of throwing (#136)", async () => {
  // A live run makes the sweep take the note path; a THROWING onNote detonates the sweep's own
  // try — the outer catch must return the zero-shape result, never reject (index.ts starts the
  // sweep with no .catch()).
  const entry = manifest({ pid: process.pid })
  await ensureRunDir(entry.runId, env)
  await writeManifest(entry.runId, entry, env)
  const { client } = makeClient()
  await expect(
    reapOrphans(client, "other-boot", {
      env,
      isProcessAlive: () => true,
      onNote: () => {
        throw new Error("detonate")
      },
    }),
  ).resolves.toEqual({ runs: 0, sessions: 0, failures: 0, live: 0, orphaned: [] })
})

describe("quarantine salvage and preservation (#136 review round 2)", () => {
  const seedTorn = async (body: string, runId = "wf_dead001"): Promise<void> => {
    const { manifestPath } = await ensureRunDir(runId, env)
    await writeFile(manifestPath, body, "utf8")
  }

  test("the torn bytes are preserved and salvageable children are aborted before tombstoning", async () => {
    // Torn AFTER the childSessionIDs region: the children are the only billing record — they get
    // salvaged from the corrupt bytes, aborted, and the torn manifest itself is preserved beside
    // the tombstone instead of being destroyed in place.
    const torn = '{\n  "runId": "wf_dead001",\n  "bootId": "old-boot",\n  "pid": 4242,\n  "sessionID": "ses_parent",\n  "childSessionIDs": ["ses_kid1", "ses_kid2"],'
    await seedTorn(torn)
    const { client, aborted } = makeClient()
    const result = await reapOrphans(client, "fresh-boot", { env, isProcessAlive: DEAD })
    expect(result.runs).toBe(1)
    expect(result.sessions).toBe(2)
    expect(aborted).toEqual(["ses_kid1", "ses_kid2"])
    const dir = join(base, "opencode", "tool-output", "ultraopen", "wf_dead001")
    const files = await readdir(dir)
    expect(files).toContain("manifest.corrupt.bak")
    expect(await readFile(join(dir, "manifest.corrupt.bak"), "utf8")).toBe(torn)
    const preserved = await readManifest("wf_dead001", env)
    expect(preserved?.status).toBe("orphaned")
  })

  test("a manifest torn before the child list salvages nothing — the parent session is never touched", async () => {
    // The salvage takes ids from the childSessionIDs REGION only; the run's own sessionID is the
    // parent conversation — aborting it would kill the user's session. Torn before the region
    // means the children are unknown and stay unabortable (documented limit).
    const torn = '{\n  "runId": "wf_dead001",\n  "sessionID": "ses_parent",\n  "args": {"payload"'
    await seedTorn(torn)
    const { client, aborted } = makeClient()
    const result = await reapOrphans(client, "fresh-boot", { env, isProcessAlive: DEAD })
    expect(result.sessions).toBe(0)
    expect(aborted).toEqual([])
    const orphaned = await readManifest("wf_dead001", env)
    expect(orphaned?.status).toBe("orphaned")
  })
})
