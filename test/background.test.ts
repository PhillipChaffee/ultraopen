import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  activeRunForSession,
  dropPending,
  isLive,
  isLiveAnywhere,
  isProcessAlive,
  promote,
  registerPending,
  resetForTests,
  runDetached,
  settlePromiseOf,
} from "../src/server/tool/background.js"
import { readManifest } from "../src/server/resume/store.js"
import { beginRun } from "../src/server/resume/persist.js"
import { executeStatus } from "../src/server/tool/status.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A task whose own failure path is itself broken — the harness must still record it. */
const BROKEN_TASK = (): Promise<void> => Promise.reject(new Error("the failure path itself broke"))

const manifest = (over: Partial<Parameters<typeof isLiveAnywhere>[0]> = {}) => ({
  runId: "wf_bgtarget1",
  bootId: "boot-a",
  pid: process.pid,
  sessionID: "parent",
  sourceHash: "h",
  argsHash: "a",
  status: "running" as const,
  childSessionIDs: [],
  startedAt: 1,
  ...over,
})

beforeEach(() => {
  resetForTests()
})

describe("launch-gating registry", () => {
  test("registerPending makes a run live for its session, synchronously", () => {
    registerPending("wf_bg000001", "s1")
    expect(activeRunForSession("s1")?.runId).toBe("wf_bg000001")
    expect(activeRunForSession("s1")?.status).toBe("pending")
    expect(isLive("wf_bg000001")).toBe(true)
  })

  test("promote moves pending to running", () => {
    registerPending("wf_bg000002", "s1")
    promote("wf_bg000002")
    expect(activeRunForSession("s1")?.status).toBe("running")
  })

  test("dropPending removes only pending entries", () => {
    registerPending("wf_bg000003", "s1")
    dropPending("wf_bg000003")
    expect(activeRunForSession("s1")).toBeUndefined()
    // A running entry is launch-gating state, not launch residue; dropping it
    // would let a second run slip past the refusal.
    registerPending("wf_bg000004", "s1")
    promote("wf_bg000004")
    dropPending("wf_bg000004")
    expect(activeRunForSession("s1")?.runId).toBe("wf_bg000004")
  })

  test("entries are scoped per session and dropped on settle", async () => {
    registerPending("wf_bg000005", "s1")
    await runDetached({ runId: "wf_bg000005", manifest: undefined, task: async () => {} })
    expect(activeRunForSession("s1")).toBeUndefined()
    expect(activeRunForSession("s2")).toBeUndefined()
  })

  test("each session sees only its own live run", () => {
    registerPending("wf_bg000006", "s1")
    registerPending("wf_bg000007", "s2")
    expect(activeRunForSession("s1")?.runId).toBe("wf_bg000006")
    expect(activeRunForSession("s2")?.runId).toBe("wf_bg000007")
  })

  test("resetForTests restores clean module state", () => {
    registerPending("wf_bg000008", "s1")
    resetForTests()
    expect(activeRunForSession("s1")).toBeUndefined()
  })
})

describe("isLiveAnywhere", () => {
  test("a completed or failed manifest is never live", () => {
    expect(isLiveAnywhere(manifest({ status: "completed" }), "boot-a")).toBe(false)
    expect(isLiveAnywhere(manifest({ status: "failed" }), "boot-a")).toBe(false)
    expect(isLiveAnywhere(manifest({ status: "orphaned" }), "boot-a")).toBe(false)
  })

  test("this boot defers to the local registry, which knows pending and running", () => {
    const target = manifest({ bootId: "boot-a", runId: "wf_bgtarge" })
    // Not registered: not live, even from this boot.
    expect(isLiveAnywhere(target, "boot-a")).toBe(false)
    registerPending("wf_bgtarge", "s1")
    expect(isLiveAnywhere(target, "boot-a")).toBe(true)
  })

  test("another boot's run is live while its pid is alive and dead otherwise", () => {
    expect(isLiveAnywhere(manifest({ bootId: "boot-b", pid: process.pid }), "boot-a")).toBe(true)
    expect(isLiveAnywhere(manifest({ bootId: "boot-b", pid: 2 ** 28 }), "boot-a")).toBe(false)
  })

  test("isProcessAlive detects a dead pid without throwing", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    // A pid far above the platform maximum is dead by construction; -1 is a
    // broadcast, not a dead pid, so it is never a valid probe target.
    expect(isProcessAlive(2 ** 30)).toBe(false)
  })
})

describe("runDetached", () => {
  let dataHome: string,
   savedXDG: string | undefined

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "ultraopen-bg-"))
    savedXDG = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = dataHome
  })

  afterEach(async () => {
    if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
    else {process.env["XDG_DATA_HOME"] = savedXDG}
    await rm(dataHome, { recursive: true, force: true })
  })

  test("clears the launch-gating state and the settle handle when the task resolves", async () => {
    registerPending("wf_bg000100", "s1")
    const pending = runDetached({ runId: "wf_bg000100", manifest: undefined, task: async () => {} })
    // The handle must exist while the task is in flight.
    expect(settlePromiseOf("wf_bg000100")).toBeDefined()
    await pending
    expect(activeRunForSession("s1")).toBeUndefined()
    // After settle the handle is gone: a late await resolves immediately rather
    // than returning the settled promise (or hanging).
    await settlePromiseOf("wf_bg000100")
  })

  test("an escaping rejection from the task persists a failure instead of vanishing", async () => {
    // The task was supposed to capture its own outcome; if its failure path
    // itself breaks, the harness must still leave an observable record.
    const opening = await beginRun({ runId: "wf_bg000101", sessionID: "s1", source: "export const meta = {name:'x',description:'x'}", args: undefined, bootId: "b" })
    await runDetached({ runId: "wf_bg000101", manifest: opening, task: BROKEN_TASK })
    const settled = await readManifest("wf_bg000101")
    expect(settled?.status).toBe("failed")
    const report = await executeStatus({ runId: "wf_bg000101" })
    expect(report.status).toBe("failed")
    expect(report.failure?.message).toContain("the failure path itself broke")
  })

  test("a settled run's children are dropped from the engine registry", async () => {
    registerPending("wf_bg000102", "s1")
    const { registry } = await import("../src/server/singleton.js")
    registry.register("child-a", "wf_bg000102")
    await runDetached({ runId: "wf_bg000102", manifest: undefined, task: async () => {} })
    expect(registry.owns("child-a")).toBe(false)
  })
})

describe("settlePromiseOf", () => {
  test("resolves immediately for an unknown run", () => {
    // A status tool that asks about a never-launched run must not hang.
    expect(settlePromiseOf("wf_nothere1")).toBeDefined()
  })
})
describe("runDetached — unwritable disk", () => {
  test("a failure write that itself fails is swallowed; the run still settles", async () => {
    // XDG under /dev/null can never be written: writeFailure rejects, its catch
    // fires, and the harness must still finish quietly.
    resetForTests()
    registerPending("wf_bg000200", "s1")
    const savedXDG = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = "/dev/null/nope"
    try {
      await runDetached({ runId: "wf_bg000200", manifest: undefined, task: BROKEN_TASK })
      expect(activeRunForSession("s1")).toBeUndefined()
    } finally {
      if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
      else {process.env["XDG_DATA_HOME"] = savedXDG}
    }
  })
})
