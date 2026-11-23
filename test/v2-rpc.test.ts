import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_RPC_SETTLED_RUNS, registerRunRpc } from "../src/server/host/v2-rpc.js"
import type { RunRpcDeps } from "../src/server/host/v2-rpc.js"
import { artifactPaths, ensureRunDir, writeManifest } from "../src/server/resume/store.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { LiveRunRecord, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { resolveOptions } from "../src/server/options.js"
import type { HostPort } from "../src/server/host/port.js"
import type { Manifest } from "../src/server/resume/journal.js"
import type { ListRunsOutput, RpcRunView } from "../src/rpc.js"
import { rpcContext } from "./v2-fixtures.js"

/**
 * The `ultraopen` RPC surface, driven through its real registered handlers.
 *
 * `listRuns` combines live coordinator runs with disk manifests. These tests pin the two
 * properties a poller depends on: a live run reports the rows it last broadcast (failures
 * included), and a history with hundreds of settled runs cannot turn one poll into hundreds of
 * disk reads. The hint path must also wait for the boot sweep, or the first poll of a session
 * races the sweep that writes the very marker it reads.
 */

let base: string,
 env: NodeJS.ProcessEnv,
 coordinator: RuntimeCoordinator

const LOCATION = { directory: "/work", project: { id: "project-1", canonical: "/work" } } as const,
 RUN_ID = "wf_rpc000001",
 SESSION = "ses_rpc1"

/** The two handlers this suite drives; the rest of the registration is not under test here. */
interface Handlers {
  listRuns: (input: unknown, context: unknown) => Promise<ListRunsOutput>
}

/** Registers the RPC against a structural fake context and returns its handlers. */
const rpcHandlers = async (envOverride: NodeJS.ProcessEnv = env): Promise<Handlers> => {
  let handlers: Handlers = {
    listRuns: () => Promise.reject(new Error("listRuns was never registered")),
  }
  const ctx = {
    rpc: {
      register: (_definition: unknown, registered: unknown) => {
        handlers = registered as Handlers
        return Promise.resolve({
          dispose: () => Promise.resolve(),
          events: { emit: () => Promise.resolve() },
        })
      },
    },
  }
  const deps: RunRpcDeps = {
    // `consumeInterruptedHints` scopes markers by project: the fake host supplies the identity.
    host: { location: { directory: "/work", canonical: "/work", projectID: "project-1" } } as HostPort,
    coordinator,
    env: envOverride,
  }
  await registerRunRpc(ctx as unknown as Plugin.Context, deps)
  return handlers
}

const manifest = (runId: string, overrides: Partial<Manifest> = {}): Manifest => ({
  runId,
  bootId: coordinator.processBootId,
  pid: process.pid,
  sessionID: SESSION,
  projectID: "project-1",
  directory: "/work",
  sourceHash: "s",
  argsHash: "a",
  status: "running",
  childSessionIDs: [],
  startedAt: 1,
  ...overrides,
})

const seed = async (runId: string, overrides: Partial<Manifest> = {}): Promise<Manifest> => {
  const entry = manifest(runId, overrides)
  await ensureRunDir(runId, env)
  await writeManifest(runId, entry, env)
  return entry
}

const liveRun = (overrides: Partial<LiveRunRecord> = {}): LiveRunRecord => {
  const record: LiveRunRecord = {
    runId: RUN_ID,
    sessionID: SESSION,
    projectKey: "project-1",
    locationDir: "/work",
    status: "running",
    startedAt: 10,
    name: "demo",
    ...overrides,
  }
  coordinator.runs.set(record.runId, record)
  return record
}

const view = (status: RpcRunView["status"] = "running"): RpcRunView => ({
  runId: RUN_ID,
  workflow: "demo",
  sessionID: SESSION,
  status,
  agents: [
    { index: 0, label: "ok-one", status: "done", outputTokens: 4 },
    { index: 1, label: "bad-one", status: "failed", reason: "idle-deadline" },
  ],
  done: 1,
  failed: 1,
  total: 2,
  startedAt: 10,
})

beforeEach(async () => {
  resetCoordinatorForTests()
  coordinator = getCoordinator()
  base = await mkdtemp(join(tmpdir(), "ultraopen-v2-rpc-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
})

afterEach(async () => {
  resetCoordinatorForTests()
  await rm(base, { recursive: true, force: true })
})

describe("listRuns", () => {
  test("listRuns returns live agent rows (including failed reason), caps settled disk runs to newest 20, and awaits bootSweepSettled before consuming hints", async () => {
    // 1) A live run reports exactly what it last broadcast, failure reasons included.
    const project = coordinator.projectOf(LOCATION, resolveOptions({}))
    liveRun()
    coordinator.emitRunUpdated(project.projectKey, view())
    const handlers = await rpcHandlers()

    const live = await handlers.listRuns({}, rpcContext())
    expect(live.runs).toHaveLength(1)
    expect(live.runs[0]?.agents).toHaveLength(2)
    expect(live.runs[0]?.agents[1]?.reason).toBe("idle-deadline")
    expect(live.runs[0]?.status).toBe("running")
    // The run's own terminal view must survive until the record is dropped: a listing between
    // settle and cleanup reports what was emitted, never a relabelled `running`.
    coordinator.emitRunUpdated(project.projectKey, view("completed"))
    const settled = await handlers.listRuns({}, rpcContext())
    expect(settled.runs[0]?.status).toBe("completed")

    // 2) Disk history is bounded: all active runs, plus only the newest MAX_RPC_SETTLED_RUNS.
    coordinator.runs.clear()
    for (let index = 0; index < 25; index++) {
      const runId = `wf_settled${String(index).padStart(3, "0")}`
      await seed(runId, { status: "completed", startedAt: index * 1000 })
    }
    const active = await seed("wf_active01", { status: "running", startedAt: 500 })

    const bounded = await handlers.listRuns({}, rpcContext())
    const settledIds = bounded.runs.filter((run) => run.status === "completed").map((run) => run.runId)
    expect(MAX_RPC_SETTLED_RUNS).toBe(20)
    expect(settledIds).toHaveLength(MAX_RPC_SETTLED_RUNS)
    // Newest first-class: the five oldest completed runs are the ones dropped.
    expect(settledIds).not.toContain("wf_settled000")
    expect(settledIds).not.toContain("wf_settled004")
    expect(settledIds).toContain("wf_settled024")
    // The active run is never dropped by the settled cap.
    expect(bounded.runs.map((run) => run.runId)).toContain(active.runId)
    expect(bounded.runs).toHaveLength(MAX_RPC_SETTLED_RUNS + 1)

    // 3) includeHints waits for the boot sweep, even when the sweep writes the marker during it.
    coordinator.runs.clear()
    await seed("wf_hint0001", { status: "orphaned", startedAt: 100 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const sweep = coordinator.runBootSweepOnce(async () => {
      await gate
      await writeFile(join(artifactPaths("wf_hint0001", env).dir, "interrupted.txt"), "wf_hint0001", "utf8")
    })
    const pending = handlers.listRuns({ includeHints: true }, rpcContext())
    await new Promise((resolve) => {setTimeout(resolve, 20)})
    release()
    await sweep
    const hinted = await pending
    expect(hinted.hints).toEqual([{ runId: "wf_hint0001", workflow: "workflow" }])
    // The marker is consumed once.
    const again = await handlers.listRuns({ includeHints: true }, rpcContext())
    expect(again.hints).toBeUndefined()
  })

  test("null, array and partial progress snapshots fall back to the manifest without crashing", async () => {
    const bodies: [string, string][] = [
      ["wf_prognull1", "null"],
      ["wf_progarr01", "[]"],
      ["wf_progpart1", "{}"],
      [
        "wf_progpart2",
        '{"workflow":5,"startedAt":"soon","phase":7,"agents":[null,{"index":1,"label":"ok","status":"done"},{"index":"x","label":"bad","status":"done"}]}',
      ],
    ]
    for (const [runId, body] of bodies) {
      await seed(runId, { status: "completed", startedAt: 7 })
      await writeFile(join(artifactPaths(runId, env).dir, "progress.json"), body, "utf8")
    }
    const handlers = await rpcHandlers()

    const output = await handlers.listRuns({}, rpcContext())
    const byId = new Map(output.runs.map((run) => [run.runId, run]))
    for (const [runId] of bodies) {
      const run = byId.get(runId)
      expect(run?.runId).toBe(runId)
      expect(run?.sessionID).toBe(SESSION)
      expect(run?.workflow).toBe("workflow")
      expect(run?.startedAt).toBe(7)
      expect(run?.status).toBe("completed")
    }
    expect(byId.get("wf_prognull1")?.agents).toEqual([])
    expect(byId.get("wf_progarr01")?.agents).toEqual([])
    expect(byId.get("wf_progpart1")?.agents).toEqual([])
    // Only the well-formed agent record survives the filter.
    expect(byId.get("wf_progpart2")?.agents).toEqual([{ index: 1, label: "ok", status: "done" }])
  })

  test("a disk run whose snapshot says stopping reports stopping while the manifest is still running", async () => {
    const runId = "wf_stopdisk1"
    await seed(runId, { status: "running", startedAt: 3 })
    await writeFile(
      join(artifactPaths(runId, env).dir, "progress.json"),
      JSON.stringify({
        runId,
        workflow: "demo",
        sessionID: SESSION,
        status: "stopping",
        agents: [],
        logs: [],
        startedAt: 3,
        updatedAt: 4,
        budget: { total: null, spent: 0 },
      }),
      "utf8",
    )
    const handlers = await rpcHandlers()

    const output = await handlers.listRuns({}, rpcContext())
    expect(output.runs[0]?.status).toBe("stopping")
  })

  test("a foreign project's interrupted marker is never consumed as this project's hint", async () => {
    const foreign = "wf_foreign01"
    await seed(foreign, { status: "orphaned", projectID: "project-2", startedAt: 100 })
    const markerPath = join(artifactPaths(foreign, env).dir, "interrupted.txt")
    await writeFile(markerPath, foreign, "utf8")
    const handlers = await rpcHandlers()

    const output = await handlers.listRuns({ includeHints: true }, rpcContext())
    expect(output.hints).toBeUndefined()
    await expect(Bun.file(markerPath).exists()).resolves.toBe(true)
  })
})
