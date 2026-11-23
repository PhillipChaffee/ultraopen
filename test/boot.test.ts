import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootSweep } from "../src/server/resume/boot.js"
import { registerRunRpc } from "../src/server/host/v2-rpc.js"
import { argsHash } from "../src/server/resume/key.js"
import {
  INTERRUPTED_MARKER,
  artifactPaths,
  ensureRunDir,
  pendingNotificationPath,
  readManifest,
  readPendingNotification,
  writeManifest,
  writePendingNotification,
  writeScript,
} from "../src/server/resume/store.js"
import type { PendingNotification } from "../src/server/resume/store.js"
import type { Manifest } from "../src/server/resume/journal.js"
import { getCoordinator, resetCoordinatorForTests, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime } from "../src/server/runtime/coordinator.js"
import type { HostPort } from "../src/server/host/port.js"
import type { ListRunsOutput } from "../src/rpc.js"
import { resolveOptions } from "../src/server/options.js"
import type { WorkflowArgs, WorkflowContext, WorkflowResult } from "../src/server/tool/workflow.js"
import { settlePromiseOf } from "../src/server/tool/background.js"
import { rpcContext } from "./v2-fixtures.js"

/**
 * The boot sweep's global/per-project split.
 *
 * Reap + outbox replay + prune are process-global and must run once per `processBootId`; the
 * resume sweep is per project. The crux is that project B booting AFTER project A still receives
 * the globally harvested candidates — otherwise one project's activation silently starves every
 * later project of its own interrupted runs.
 */

let base: string,
 env: NodeJS.ProcessEnv,
 coordinator: RuntimeCoordinator,
 synthetic: { id: string; sessionID: string; text: string }[]

const SCRIPT = "export const meta = { name: 'boot-demo', description: 'boot' }\nreturn 'ok'\n"

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-boot-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
  resetCoordinatorForTests()
  coordinator = getCoordinator()
  synthetic = []
})

afterEach(async () => {
  resetCoordinatorForTests()
  await rm(base, { recursive: true, force: true })
})

const manifest = (runId: string, projectID: string): Manifest => ({
  runId,
  bootId: "old-boot",
  pid: 999_999,
  sessionID: `ses_${runId}`,
  projectID,
  // Each fake project owns its own directory: two V2 projects cannot share one canonical root,
  // and a shared root is exactly the alias case auto-resume now (correctly) treats as one project.
  directory: `/dir/${projectID}`,
  sourceHash: "s",
  argsHash: argsHash({}),
  args: {},
  status: "running",
  childSessionIDs: [],
  startedAt: Date.now() - 1000,
})

const seed = async (runId: string, projectID: string): Promise<void> => {
  await ensureRunDir(runId, env)
  await writeManifest(runId, manifest(runId, projectID), env)
  await writeScript(runId, SCRIPT, env)
}

const makeHost = (projectID: string, admit: HostPort["admitSynthetic"] = () => Promise.resolve("admitted")): HostPort => ({
  location: { directory: `/dir/${projectID}`, canonical: `/dir/${projectID}`, projectID },
  defaultModel: () => Promise.resolve(undefined),
  listModels: () => Promise.resolve([]),
  getSession: (sessionID) =>
    Promise.resolve({ id: sessionID, projectID, directory: `/dir/${projectID}`, agent: "build", outputTokens: 0 }),
  getAgent: (agentID) =>
    Promise.resolve({ id: agentID, mode: "primary", hidden: false, permissions: [] }),
  listAgents: () => Promise.resolve([]),
  listPendingPermissions: () => Promise.resolve([]),
  rejectPermission: () => Promise.resolve(),
  createChildSession: () => Promise.resolve({ ok: true, sessionID: "child-created" }),
  moveSession: () => Promise.resolve({ ok: true }),
  runTurn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "", outputTokens: 0 } }),
  interruptSession: () => Promise.resolve(true),
  admitSynthetic: (input) => {
    synthetic.push({ id: input.id, sessionID: input.sessionID, text: input.text })
    return admit(input)
  },
})

const makeProject = (projectID: string): ProjectRuntime =>
  coordinator.projectOf(
    { directory: "/work", project: { id: projectID, canonical: `/canonical/${projectID}` } },
    resolveOptions({ autoResumeMax: 5 }),
  )

const executeFn = (_args: WorkflowArgs, context: WorkflowContext): Promise<WorkflowResult> => Promise.resolve({
  runId: context.runId,
  meta: { name: "boot-demo", description: "boot" },
  value: "ok",
  agentCount: 0,
  nulls: [],
  logs: [],
  outputTokens: 0,
  journal: [],
  childSessionIDs: [],
})

const statusOf = async (runId: string): Promise<Manifest["status"] | undefined> => {
  const current = await readManifest(runId, env)
  return current?.status
}

interface ListRunsHandlers {
  listRuns: (input: unknown, context: unknown) => Promise<ListRunsOutput>
}

/** Registers the real `listRuns` handler against a structural fake, as the activation does. */
const rpcHandlers = async (host: HostPort): Promise<ListRunsHandlers> => {
  let handlers: ListRunsHandlers = {
    listRuns: () => Promise.reject(new Error("listRuns was never registered")),
  }
  const ctx = {
    rpc: {
      register: (_definition: unknown, registered: unknown) => {
        handlers = registered as ListRunsHandlers
        return Promise.resolve({
          dispose: () => Promise.resolve(),
          events: { emit: () => Promise.resolve() },
        })
      },
    },
  }
  await registerRunRpc(ctx as unknown as Plugin.Context, { host, coordinator, env })
  return handlers
}

const outboxRecord = (runId: string, status: "completed" | "cancelled" = "completed"): PendingNotification => ({
  id: `msg_ultraopen_outcome_${runId}`,
  sessionID: "ses_outbox",
  runId,
  workflow: "boot-demo",
  status: status === "cancelled" ? "completed" : status,
  text: `<workflow-completed run="${runId}" workflow="boot-demo">ok</workflow-completed>`,
  description: "Workflow boot-demo completed",
})

const seedOutbox = async (runId: string, status: "completed" | "cancelled"): Promise<void> => {
  await ensureRunDir(runId, env)
  await writeManifest(runId, { ...manifest(runId, "project-1"), status, startedAt: Date.now() }, env)
  await writePendingNotification(outboxRecord(runId, status), env)
}

describe("runBootSweepOnce — the coordinator caches the sweep result", () => {
  test("caches and returns the orphan list on the coordinator itself (no module WeakMap)", async () => {
    const isolated = new RuntimeCoordinator()
    const first = await isolated.runBootSweepOnce(() => Promise.resolve(["a", "b"]))
    const second = await isolated.runBootSweepOnce(() => Promise.resolve(["should-not-run"]))
    expect(first).toEqual(["a", "b"])
    expect(second).toEqual(["a", "b"])
    await expect(isolated.bootSweepSettled()).resolves.toBeUndefined()
  })

  test("bootSweepSettled resolves immediately before any sweep and swallows a rejection", async () => {
    const fresh = new RuntimeCoordinator()
    await expect(fresh.bootSweepSettled()).resolves.toBeUndefined()

    const failing = new RuntimeCoordinator()
    const sweep = failing.runBootSweepOnce(() => Promise.reject(new Error("sweep boom")))
    await expect(failing.bootSweepSettled()).resolves.toBeUndefined()
    await expect(sweep).rejects.toThrow("sweep boom")
  })
})

describe("bootSweep — the global sweep runs once, every project keeps its candidates", () => {
  test("project B booting after project A still resumes B's run from A's cached harvest", async () => {
    const runA = "wf_boota0001",
     runB = "wf_bootb0001"
    await seed(runA, "project-1")
    await seed(runB, "project-2")

    await bootSweep(makeHost("project-1"), makeProject("project-1"), coordinator, {
      env,
      executeFn,
      isProcessAlive: () => false,
    })

    await settlePromiseOf(coordinator, runA)
    // A adopted its own run; B was reaped globally but is filtered out of A's project sweep.
    expect(await statusOf(runA)).toBe("completed")
    expect(await statusOf(runB)).toBe("orphaned")

    // A run left `running` AFTER the process's one global sweep is not re-reaped by a later
    // project's boot: the global stage is genuinely once-per-process.
    const runC = "wf_bootc0001"
    await seed(runC, "project-2")

    // B boots later in the SAME process: the global sweep is not repeated, but its cached orphan
    // list still reaches B's resume sweep, so B's own run is adopted.
    await bootSweep(makeHost("project-2"), makeProject("project-2"), coordinator, {
      env,
      executeFn,
      isProcessAlive: () => false,
    })

    await settlePromiseOf(coordinator, runB)
    expect(await statusOf(runB)).toBe("completed")
    expect(await statusOf(runA)).toBe("completed")
    expect(await statusOf(runC)).toBe("running")
    expect(synthetic.some((entry) => entry.id === `msg_ultraopen_outcome_${runB}`)).toBe(true)
  })
})

describe("bootSweepSettled — the full sweep precedes hint consumption", () => {
  test("a hint poll racing an auto-resumable orphan never steals the autoresume marker", async () => {
    const runId = "wf_bootrace1"
    await seed(runId, "project-1")
    const baseHost = makeHost("project-1")
    // Hold the resume sweep inside its session lookup. Nothing else in the boot sweep calls
    // `getSession`, so this gate separates "the reaper wrote the marker" from "autoresume claimed
    // it" — the exact window a hint poll used to win.
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const host: HostPort = {
      ...baseHost,
      getSession: async (sessionID: string) => {
        await gate
        return await baseHost.getSession(sessionID)
      },
    }
    const handlers = await rpcHandlers(host)

    // The sweep is invoked exactly as setup's synchronous tail does; the first TUI poll (the
    // one-shot `includeHints` ask) lands before the sweep can finish.
    const sweep = bootSweep(host, makeProject("project-1"), coordinator, {
      env,
      executeFn,
      isProcessAlive: () => false,
    })
    const pending = handlers.listRuns({ includeHints: true }, rpcContext())

    // Give the unfixed ordering every chance to resolve early: it would read and unlink the marker
    // while the resume sweep is still parked at `getSession`.
    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    release()

    const listed = await pending
    // `bootSweepSettled` waited for `resumeInterruptedRuns`: the run was claimed by autoresume
    // before the hint reader ran, so no manual hint is returned and no marker is unlinked.
    expect(listed.hints).toBeUndefined()
    await sweep
    await settlePromiseOf(coordinator, runId)
    expect(await statusOf(runId)).toBe("completed")
    const marker = Bun.file(join(artifactPaths(runId, env).dir, INTERRUPTED_MARKER))
    await expect(marker.exists()).resolves.toBe(false)

    // Nothing is left behind for a later poll to claim as a hint either.
    const again = await handlers.listRuns({ includeHints: true }, rpcContext())
    expect(again.hints).toBeUndefined()
  })
})

describe("bootSweep — the durable outbox replay", () => {
  test("admits a standing notification once, then unlinks it", async () => {
    const runId = "wf_bootout01"
    await seedOutbox(runId, "completed")

    await bootSweep(makeHost("project-1"), makeProject("project-1"), coordinator, { env, isProcessAlive: () => false })

    expect(synthetic.map((entry) => entry.id)).toEqual([`msg_ultraopen_outcome_${runId}`])
    expect(await readPendingNotification(runId, env)).toBeUndefined()
  })

  test("a cancelled run's outbox is deleted without ever being sent", async () => {
    const runId = "wf_bootcan01"
    await seedOutbox(runId, "cancelled")

    await bootSweep(makeHost("project-1"), makeProject("project-1"), coordinator, { env, isProcessAlive: () => false })

    expect(synthetic).toEqual([])
    await expect(Bun.file(pendingNotificationPath(runId, env)).exists()).resolves.toBe(false)
  })

  test("a failed admission keeps the outbox for the next boot", async () => {
    const runId = "wf_booterr01"
    await seedOutbox(runId, "completed")

    await bootSweep(makeHost("project-1", () => Promise.resolve("error")), makeProject("project-1"), coordinator, {
      env,
      isProcessAlive: () => false,
    })

    expect(await readPendingNotification(runId, env)).toBeDefined()
  })

  test("a throwing admission is treated as an error and keeps the outbox", async () => {
    const runId = "wf_bootthr01"
    await seedOutbox(runId, "completed")

    await bootSweep(makeHost("project-1", () => Promise.reject(new Error("transport down"))), makeProject("project-1"), coordinator, {
      env,
      isProcessAlive: () => false,
    })

    expect(await readPendingNotification(runId, env)).toBeDefined()
  })

  test("a session-missing admission deletes the outbox", async () => {
    const runId = "wf_bootmis01"
    await seedOutbox(runId, "completed")

    await bootSweep(makeHost("project-1", () => Promise.resolve("session-missing")), makeProject("project-1"), coordinator, {
      env,
      isProcessAlive: () => false,
    })

    expect(await readPendingNotification(runId, env)).toBeUndefined()
  })
})
