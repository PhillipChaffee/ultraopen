import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pruneRuns, reapOrphans, salvagePid } from "../src/server/resume/reaper.js"
import {
  ensureRunDir,
  isProcessAlive,
  pendingNotificationPath,
  readManifest,
  readManifestState,
  readPendingNotification,
  writeManifest,
  writePendingNotification,
} from "../src/server/resume/store.js"
import type { PendingNotification } from "../src/server/resume/store.js"
import type { Manifest } from "../src/server/resume/journal.js"
import type { HostPort } from "../src/server/host/port.js"
import { bootSweep } from "../src/server/resume/boot.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { resolveOptions } from "../src/server/options.js"

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
 DEAD = (): boolean => false,

 finished = (startedAt: number, endedAt?: number): Partial<Manifest> => ({
  status: "completed",
  startedAt,
  ...(endedAt === undefined ? {} : { endedAt }),
 })

interface FakeHost {
  host: HostPort
  aborted: string[]
  synthetic: { id: string; sessionID: string }[]
}

/** A HostPort whose interrupt outcome a test can script; admitted synthetics are recorded. */
function makeHost(
  interrupt: (id: string) => Promise<boolean> = (): Promise<boolean> => Promise.resolve(true),
  admit: HostPort["admitSynthetic"] = (): Promise<"admitted"> => Promise.resolve("admitted"),
): FakeHost {
  const aborted: string[] = [],
   synthetic: { id: string; sessionID: string }[] = []
  const host: HostPort = {
    location: { directory: "/work", canonical: "/work", projectID: "project-1" },
    defaultModel: () => Promise.resolve(undefined),
    listModels: () => Promise.resolve([]),
    getSession: () => Promise.resolve(undefined),
    getAgent: () => Promise.resolve(undefined),
    listAgents: () => Promise.resolve([]),
    listPendingPermissions: () => Promise.resolve([]),
    rejectPermission: () => Promise.resolve(),
    createChildSession: () => Promise.resolve({ ok: true, sessionID: "child" }),
    moveSession: () => Promise.resolve({ ok: true }),
    runTurn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "", outputTokens: 0 } }),
    interruptSession: (id) => {
      aborted.push(id)
      return interrupt(id)
    },
    admitSynthetic: (input) => {
      synthetic.push({ id: input.id, sessionID: input.sessionID })
      return admit(input)
    },
  }
  return { host, aborted, synthetic }
}

const makeProject = (coordinator: RuntimeCoordinator): ProjectRuntime =>
  coordinator.projectOf({ directory: "/work", project: { id: "project-1", canonical: "/work" } }, resolveOptions({}))

const statusAt = async (runId: string, atEnv: NodeJS.ProcessEnv = env): Promise<Manifest["status"] | undefined> => {
  const current = await readManifest(runId, atEnv)
  return current?.status
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-reap-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
  resetCoordinatorForTests()
})

afterEach(async () => {
  // Restore write permission before cleanup: tests make run DIRECTORIES read-only (atomic
  // writes are blocked by the directory), and rm needs the write back.
  await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_dead001"), 0o700).catch(
    (): undefined => undefined,
  )
  await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_dead001", "manifest.json"), 0o600).catch(
    (): undefined => undefined,
  )
  await rm(base, { recursive: true, force: true })
})

describe("reapOrphans", () => {
  const seed = async (overrides: Partial<Manifest> = {}): Promise<Manifest> => {
    const entry = manifest(overrides)
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    return entry
  }

  test("interrupts every child of a run abandoned by a dead process", async () => {
    const entry = await seed()
    const { host, aborted } = makeHost()

    const result = await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })
    expect(aborted).toEqual(["child-1", "child-2"])
    expect(result).toEqual({ runs: 1, sessions: 2, failures: 0, live: 0, orphaned: [entry] })
  })

  test("leaves an interrupted marker the TUI reads, so the next start hints", async () => {
    const { host } = makeHost()
    const entry = await seed({ pid: 424_242 })
    await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })
    const marker = await readFile(join(env["XDG_DATA_HOME"] ?? "", "opencode", "tool-output", "ultraopen", entry.runId, "interrupted.txt"), "utf8")
    expect(marker).toBe(entry.runId)
  })

  test("a run skipped for a live owner leaves no marker", async () => {
    const { host } = makeHost()
    await seed({ pid: 424_242 })
    await reapOrphans(host, "current-boot", { env, isProcessAlive: () => true })
    const markerPath = join(env["XDG_DATA_HOME"] ?? "", "opencode", "tool-output", "ultraopen")
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
    const first = makeHost()
    await reapOrphans(first.host, "current-boot", { env, isProcessAlive: DEAD })

    expect(await statusAt("wf_dead001", env)).toBe("orphaned")

    const second = makeHost()
    expect(await reapOrphans(second.host, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
    expect(second.aborted).toEqual([])
  })

  test("stamps the orphaning moment, which opens both the resume and prune windows", async () => {
    await seed()
    const { host } = makeHost(),
      before = Date.now()
    await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })

    const orphanManifest = await readManifest("wf_dead001", env)
    expect(orphanManifest?.endedAt).toBeGreaterThanOrEqual(before)
    expect(orphanManifest?.endedAt ?? 0).toBeLessThanOrEqual(Date.now())
  })

  test("skips a run whose owning process is still alive, visibly", async () => {
    await seed()
    const notes: string[] = [],
     { host, aborted } = makeHost()

    const result = await reapOrphans(host, "current-boot", {
      env,
      isProcessAlive: () => true,
      onNote: (note) => notes.push(note),
    })
    expect(aborted).toEqual([])
    expect(result).toEqual({ runs: 0, sessions: 0, failures: 0, live: 1, orphaned: [] })
    expect(await statusAt("wf_dead001", env)).toBe("running")
    expect(notes[0]).toContain("still alive")
  })

  test("isProcessAlive treats an out-of-range pid as dead", () => {
    expect(isProcessAlive(2 ** 31 - 2)).toBe(false)
  })

  test("leaves runs from the CURRENT boot alone", async () => {
    await seed({ bootId: "current-boot" })
    const { host, aborted } = makeHost()

    expect(await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 0,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
    expect(aborted).toEqual([])
  })

  test("counts an interrupt the host could not confirm and still marks the run orphaned", async () => {
    const entry = await seed()
    const { host } = makeHost((id) => Promise.resolve(id !== "child-1"))

    const result = await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })
    expect(result).toEqual({ runs: 1, sessions: 1, failures: 1, live: 0, orphaned: [entry] })
    expect(await statusAt("wf_dead001", env)).toBe("orphaned")
  })

  test("counts a throwing interrupt as a failure and keeps going", async () => {
    const entry = await seed()
    const { host } = makeHost((id) => (id === "child-1" ? Promise.reject(new Error("gone")) : Promise.resolve(true)))

    const result = await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })
    expect(result).toEqual({ runs: 1, sessions: 1, failures: 1, live: 0, orphaned: [entry] })
  })

  test("reports what it released and names unconfirmed interrupts", async () => {
    await seed()
    const notes: string[] = [],
     { host } = makeHost(() => Promise.reject(new Error("gone")))
    await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })

    expect(notes[0]).toContain("released 0 subagent session(s)")
    expect(notes[0]).toContain("1 interrupted run(s)")
    expect(notes[0]).toContain("2 could not be aborted")
  })

  test("stays silent and cheap when there is nothing to reap", async () => {
    const notes: string[] = [],
     { host } = makeHost()
    expect(await reapOrphans(host, "boot", { env, isProcessAlive: DEAD, onNote: (note) => notes.push(note) })).toEqual({
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
    const { host } = makeHost()
    expect(await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })).toEqual({
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
    const notADirectory = join(base, "file.txt")
    await Bun.write(notADirectory, "x")
    const { host } = makeHost()

    expect(
      await reapOrphans(host, "boot", { env: { XDG_DATA_HOME: notADirectory } as NodeJS.ProcessEnv }),
    ).toEqual({ runs: 0, sessions: 0, failures: 0, live: 0, orphaned: [] })
  })

  test("a manifest that cannot be rewritten still counts the aborts it managed", async () => {
    const entry = manifest()
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    // Atomic writes (#136) rename over the target, so the DIRECTORY permission is what blocks
    // the write: an unwritable run dir makes the tombstone write fail while aborts still land.
    await chmod(join(base, "opencode", "tool-output", "ultraopen", entry.runId), 0o500)

    const { host, aborted } = makeHost()
    const result = await reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })

    expect(aborted).toEqual(["child-1", "child-2"])
    expect(result.sessions).toBe(2)
  })
})

describe("non-throwing contract", () => {
  test("never rejects, so callers can fire-and-forget without a handler", async () => {
    const entry = manifest()
    await ensureRunDir(entry.runId, env)
    await writeManifest(entry.runId, entry, env)
    await chmod(join(base, "opencode", "tool-output", "ultraopen", entry.runId), 0o500)

    const { host } = makeHost(() => Promise.reject(new Error("everything is broken")))
    await expect(reapOrphans(host, "current-boot", { env, isProcessAlive: DEAD })).resolves.toBeDefined()
  })
})

describe("pruneRuns", () => {
  test("deletes finished runs past the retention window and keeps everything else", async () => {
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
    expect(await readManifest("wf_liverun", env)).toBeDefined()
  })

  test("an orphaned run inside the resume window survives pruning", async () => {
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
  const { host } = makeHost()
  const result = await reapOrphans(host, "fresh-boot", { env, isProcessAlive: DEAD })
  expect(result.runs).toBe(1)
  expect(await statusAt("wf_dead001", env)).toBe("orphaned")
  const pruned = await pruneRuns({ env, now: Date.now() + 31 * 24 * 60 * 60 * 1000, autoResumeTtlHours: 24 })
  expect(pruned).toBe(1)
})

describe("quarantine respects the live-pid veto (#136 review)", () => {
  const seedTorn = async (body: string, runId = "wf_dead001"): Promise<void> => {
    const { manifestPath } = await ensureRunDir(runId, env)
    await writeFile(manifestPath, body, "utf8")
  }

  test("a torn manifest whose pid is salvageable and alive is left untouched — no tombstone, no marker", async () => {
    await seedTorn('{\n  "runId": "wf_dead001",\n  "bootId": "old-boot",\n  "pid": 4242,')
    const { host } = makeHost()
    expect(await reapOrphans(host, "fresh-boot", { env, isProcessAlive: () => true })).toEqual({
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
    const { host } = makeHost()
    expect(await reapOrphans(host, "fresh-boot", { env, isProcessAlive: DEAD })).toEqual({
      runs: 1,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
    expect(await statusAt("wf_dead001", env)).toBe("orphaned")
  })

  test("no salvageable pid means no veto — the same rule as the orphan pass with a missing pid", async () => {
    await seedTorn("{torn")
    const { host } = makeHost()
    expect(await reapOrphans(host, "fresh-boot", { env, isProcessAlive: () => true })).toEqual({
      runs: 1,
      sessions: 0,
      failures: 0,
      live: 0,
      orphaned: [],
    })
  })

  test("the veto rides the default process probe too", async () => {
    await seedTorn(`{\n  "runId": "wf_dead001",\n  "pid": ${String(process.pid)},`)
    const { host } = makeHost(),
     probed = await reapOrphans(host, "fresh-boot", { env }),
     tornState = await readManifestState("wf_dead001", env)
    expect(probed.live).toBe(1)
    expect(tornState.state).toBe("corrupt")
  })

  test("a salvageable-but-impossible pid (overflow) is no veto", async () => {
    await seedTorn(`{\n  "pid": ${"9".repeat(400)},`)
    const { host } = makeHost(),
     result = await reapOrphans(host, "fresh-boot", { env, isProcessAlive: () => true })
    expect(result.runs).toBe(1)
  })

  test("a quarantine veto surfaces in the same live-skip accounting as an orphan-pass skip", async () => {
    await seedTorn('{\n  "runId": "wf_torn001",\n  "pid": 4242,', "wf_torn001")
    await ensureRunDir("wf_dead001", env)
    await writeManifest("wf_dead001", manifest({ pid: 424_242 }), env)
    const notes: string[] = [],
     { host } = makeHost()
    expect(await reapOrphans(host, "fresh-boot", { env, isProcessAlive: () => true, onNote: (note) => notes.push(note) })).toEqual({
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
  const entry = manifest({ pid: process.pid })
  await ensureRunDir(entry.runId, env)
  await writeManifest(entry.runId, entry, env)
  const { host } = makeHost()
  await expect(
    reapOrphans(host, "other-boot", {
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

  test("torn bytes are preserved and salvageable children are interrupted before tombstoning", async () => {
    const torn = '{\n  "runId": "wf_dead001",\n  "bootId": "old-boot",\n  "pid": 4242,\n  "sessionID": "ses_parent",\n  "childSessionIDs": ["ses_kid1", "ses_kid2"],'
    await seedTorn(torn)
    const { host, aborted } = makeHost()
    const result = await reapOrphans(host, "fresh-boot", { env, isProcessAlive: DEAD })
    expect(result.runs).toBe(1)
    expect(result.sessions).toBe(2)
    expect(aborted).toEqual(["ses_kid1", "ses_kid2"])
    const dir = join(base, "opencode", "tool-output", "ultraopen", "wf_dead001")
    const files = await readdir(dir)
    expect(files).toContain("manifest.corrupt.bak")
    expect(await readFile(join(dir, "manifest.corrupt.bak"), "utf8")).toBe(torn)
    expect(await statusAt("wf_dead001", env)).toBe("orphaned")
  })

  test("a manifest torn before the child list salvages nothing — the parent session is never touched", async () => {
    const torn = '{\n  "runId": "wf_dead001",\n  "sessionID": "ses_parent",\n  "args": {"payload"'
    await seedTorn(torn)
    const { host, aborted } = makeHost()
    const result = await reapOrphans(host, "fresh-boot", { env, isProcessAlive: DEAD })
    expect(result.sessions).toBe(0)
    expect(aborted).toEqual([])
    expect(await statusAt("wf_dead001", env)).toBe("orphaned")
  })
})

const pendingNotification = (overrides: Partial<PendingNotification> = {}): PendingNotification => ({
  id: "msg_ultraopen_outcome_wf_outbox1",
  sessionID: "ses_parent",
  runId: "wf_outbox1",
  workflow: "audit",
  status: "completed",
  text: "<workflow-completed run=\"wf_outbox1\" workflow=\"audit\">ok</workflow-completed>",
  description: "Workflow audit completed",
  ...overrides,
})

describe("bootSweep — the durable outbox", () => {
  test("replays a standing notification once and unlinks it after admission", async () => {
    await ensureRunDir("wf_outbox1", env)
    await writeManifest("wf_outbox1", manifest({ runId: "wf_outbox1", status: "completed", startedAt: Date.now() }), env)
    await writePendingNotification(pendingNotification(), env)

    const coordinator = getCoordinator(),
     project = makeProject(coordinator),
     { host, synthetic } = makeHost()
    await bootSweep(host, project, coordinator, { env, isProcessAlive: DEAD })

    expect(synthetic).toEqual([{ id: "msg_ultraopen_outcome_wf_outbox1", sessionID: "ses_parent" }])
    expect(await readPendingNotification("wf_outbox1", env)).toBeUndefined()

    await bootSweep(host, project, coordinator, { env, isProcessAlive: DEAD })
    expect(synthetic).toHaveLength(1)
  })

  test("a cancelled run's outbox is deleted without ever being sent", async () => {
    await ensureRunDir("wf_outbox1", env)
    await writeManifest("wf_outbox1", manifest({ runId: "wf_outbox1", status: "cancelled", startedAt: Date.now() }), env)
    await writePendingNotification(pendingNotification(), env)

    const coordinator = getCoordinator(),
     project = makeProject(coordinator),
     { host, synthetic } = makeHost()
    await bootSweep(host, project, coordinator, { env, isProcessAlive: DEAD })

    expect(synthetic).toEqual([])
    await expect(Bun.file(pendingNotificationPath("wf_outbox1", env)).exists()).resolves.toBe(false)
  })

  test("a throwing admission is treated as an error and keeps the outbox", async () => {
    await ensureRunDir("wf_outbox1", env)
    await writeManifest("wf_outbox1", manifest({ runId: "wf_outbox1", status: "completed", startedAt: Date.now() }), env)
    await writePendingNotification(pendingNotification(), env)

    const coordinator = getCoordinator(),
     project = makeProject(coordinator),
     { host } = makeHost(
       () => Promise.resolve(true),
       () => Promise.reject(new Error("transport down")),
     )
    await bootSweep(host, project, coordinator, { env, isProcessAlive: DEAD })

    expect(await readPendingNotification("wf_outbox1", env)).toBeDefined()
  })

  test("a failed admission keeps the outbox for the next boot", async () => {
    await ensureRunDir("wf_outbox1", env)
    await writeManifest("wf_outbox1", manifest({ runId: "wf_outbox1", status: "completed", startedAt: Date.now() }), env)
    await writePendingNotification(pendingNotification(), env)

    const coordinator = getCoordinator(),
     project = makeProject(coordinator),
     { host } = makeHost(
       () => Promise.resolve(true),
       () => Promise.resolve("error" as const),
     )
    await bootSweep(host, project, coordinator, { env, isProcessAlive: DEAD })

    expect(await readPendingNotification("wf_outbox1", env)).toBeDefined()
  })
})
