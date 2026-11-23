import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HYDRATION_CAP,
  capAtLineBoundary,
  classifyHost,
  deliverOutcomeUnlessStopped,
  dropPending,
  dropSettled,
  hydrateParent,
  isLive,
  isLiveAnywhere,
  isLongLivedHost,
  liveRunsForSession,
  nameRun,
  notifyStopped,
  promote,
  registerPending,
  runDetached,
  siblingRunsForSession,
  stopRun,
} from "../src/server/tool/background.js"
import { artifactPaths, ensureRunDir, pendingNotificationPath, readManifest, readPendingNotification, writeManifest } from "../src/server/resume/store.js"
import type { Manifest } from "../src/server/resume/journal.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { LiveRunRecord, ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import type { HostPort } from "../src/server/host/port.js"
import { progressPath } from "../src/server/resume/progress.js"
import type { ProgressSnapshot } from "../src/server/resume/progress.js"
import { resolveOptions } from "../src/server/options.js"
import type { RpcRunView } from "../src/rpc.js"

/**
 * The V2 lifecycle contracts: deterministic `msg_` hydration through the durable outbox,
 * confirmed stop settlement (stopping first, interrupts awaited, cancel committed last), and the
 * coordinator-backed live-run queries Task 8's launch gate will read.
 */

let base: string,
 env: NodeJS.ProcessEnv,
 coordinator: RuntimeCoordinator

const SESSION = "parent",
 RUN_ID = "wf_bg000001",
 LOCATION = { directory: "/work", project: { id: "project-1", canonical: "/work" } } as const

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-bg-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
  resetCoordinatorForTests()
  coordinator = getCoordinator()
})

afterEach(async () => {
  resetCoordinatorForTests()
  await rm(base, { recursive: true, force: true })
})

interface AdmitInput {
  sessionID: string
  id: string
  text: string
  description?: string | undefined
  metadata?: Record<string, unknown> | undefined
  delivery?: string | undefined
  resume?: boolean | undefined
}

interface FakeHost {
  host: HostPort
  admitted: AdmitInput[]
  interrupted: string[]
  sequence: string[]
}

const makeHost = (
  options: {
    admit?: HostPort["admitSynthetic"] | undefined
    interrupt?: ((sessionID: string) => Promise<boolean>) | undefined
  } = {},
): FakeHost => {
  const admitted: AdmitInput[] = [],
   interrupted: string[] = [],
   sequence: string[] = []
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
    interruptSession: (sessionID) => {
      interrupted.push(sessionID)
      sequence.push("interrupt")
      return options.interrupt ? options.interrupt(sessionID) : Promise.resolve(true)
    },
    admitSynthetic: (input) => {
      admitted.push(input)
      sequence.push("admit")
      return options.admit ? options.admit(input) : Promise.resolve("admitted")
    },
  }
  return { host, admitted, interrupted, sequence }
}

const makeProject = (): ProjectRuntime => coordinator.projectOf(LOCATION, resolveOptions({}))

const makeLive = (overrides: Partial<LiveRunRecord> = {}): LiveRunRecord => {
  const record: LiveRunRecord = {
    runId: RUN_ID,
    sessionID: SESSION,
    projectKey: "project-1",
    locationDir: "/work",
    status: "running",
    startedAt: Date.now(),
    name: "demo",
    ...overrides,
  }
  coordinator.runs.set(record.runId, record)
  return record
}

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  runId: RUN_ID,
  bootId: coordinator.processBootId,
  pid: process.pid,
  sessionID: SESSION,
  projectID: "project-1",
  directory: "/work",
  sourceHash: "h",
  argsHash: "a",
  status: "running",
  childSessionIDs: [],
  startedAt: 1,
  ...overrides,
})

const seedManifest = async (overrides: Partial<Manifest> = {}): Promise<Manifest> => {
  const entry = manifest(overrides)
  await ensureRunDir(entry.runId, env)
  await writeManifest(entry.runId, entry, env)
  return entry
}

const statusAt = async (runId: string, atEnv: NodeJS.ProcessEnv = env): Promise<Manifest["status"] | undefined> => {
  const current = await readManifest(runId, atEnv)
  return current?.status
}

const view = (status: RpcRunView["status"] = "running"): RpcRunView => ({
  runId: RUN_ID,
  workflow: "demo",
  sessionID: SESSION,
  status,
  agents: [],
  done: 0,
  failed: 0,
  total: 0,
  startedAt: 1,
})

describe("hydration rendering", () => {
  test("under the cap the whole text hydrates", () => {
    expect(capAtLineBoundary("line one\nline two")).toBe("line one\nline two")
  })

  test("over the cap, whole lines are kept, no line is split, and at least one line survives", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line-${index}-${"x".repeat(40)}`),
     capped = capAtLineBoundary(lines.join("\n"))
    expect(capped.length).toBeLessThanOrEqual(HYDRATION_CAP)
    for (const line of capped.split("\n")) {expect(lines).toContain(line)}
    const huge = "y".repeat(HYDRATION_CAP + 50)
    expect(capAtLineBoundary(huge)).toBe(huge)
  })
})

describe("host classification", () => {
  test("the V2 argv shapes map to the two contracts", () => {
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "serve", "--stdio", "--port", "0"])).toBe("ephemeral")
    expect(isLongLivedHost(["bun", "/$bunfs/root/opencode", "serve", "--stdio", "--port", "0"])).toBe(false)
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "serve", "--port", "4096"])).toBe("shared-service")
    expect(isLongLivedHost(["bun", "/$bunfs/root/opencode", "serve", "--port", "4096"])).toBe(true)
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "service"])).toBe("shared-service")
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "run", "hi"])).toBe("ephemeral")
  })
})

describe("the coordinator-backed run registry", () => {
  test("registerPending, promote and the session queries carry status and start order", () => {
    registerPending(coordinator, { runId: RUN_ID, sessionID: SESSION, projectKey: "project-1", locationDir: "/work" }, 100)
    registerPending(coordinator, { runId: "wf_bg000002", sessionID: SESSION, projectKey: "project-1", locationDir: "/work" }, 200)
    nameRun(coordinator, RUN_ID, "demo", "Fix the login bug")
    expect(liveRunsForSession(coordinator, SESSION).map((run) => run.runId)).toEqual([RUN_ID, "wf_bg000002"])
    expect(isLive(coordinator, RUN_ID)).toBe(true)

    promote(coordinator, RUN_ID)
    expect(coordinator.runs.get(RUN_ID)?.status).toBe("running")
    expect(siblingRunsForSession(coordinator, SESSION, RUN_ID).map((run) => run.runId)).toEqual(["wf_bg000002"])
  })

  test("dropPending removes only pending entries; dropSettled removes any entry", () => {
    const register = (runId: string): void => {
      registerPending(coordinator, { runId, sessionID: SESSION, projectKey: "project-1", locationDir: "/work" })
    }
    register("wf_bg000003")
    dropPending(coordinator, "wf_bg000003")
    expect(isLive(coordinator, "wf_bg000003")).toBe(false)

    register("wf_bg000004")
    promote(coordinator, "wf_bg000004")
    dropPending(coordinator, "wf_bg000004")
    expect(isLive(coordinator, "wf_bg000004")).toBe(true)
    dropSettled(coordinator, "wf_bg000004")
    expect(isLive(coordinator, "wf_bg000004")).toBe(false)
  })

  test("isLiveAnywhere defers to the coordinator on this boot and to the pid on another", () => {
    const entry = manifest()
    expect(isLiveAnywhere(entry, coordinator)).toBe(false)
    registerPending(coordinator, { runId: RUN_ID, sessionID: SESSION, projectKey: "project-1", locationDir: "/work" })
    expect(isLiveAnywhere(entry, coordinator)).toBe(true)
    expect(isLiveAnywhere(manifest({ bootId: "other", pid: process.pid }), coordinator)).toBe(true)
    expect(isLiveAnywhere(manifest({ bootId: "other", pid: 2 ** 28 }), coordinator)).toBe(false)
  })
})

describe("hydrateParent", () => {
  test("admits a deterministic outcome message with description, metadata, steer and resume", async () => {
    const { host, admitted } = makeHost()
    const result = await hydrateParent(host, SESSION, {
      status: "completed",
      workflow: "demo",
      runId: RUN_ID,
      body: "the value",
    })
    expect(result).toBe("admitted")
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.id).toBe(`msg_ultraopen_outcome_${RUN_ID}`)
    expect(admitted[0]?.sessionID).toBe(SESSION)
    expect(admitted[0]?.description).toBe("Workflow demo completed")
    expect(admitted[0]?.metadata).toEqual({
      ultraopen: { kind: "outcome", runId: RUN_ID, workflow: "demo", status: "completed" },
    })
    expect(admitted[0]?.delivery).toBe("steer")
    expect(admitted[0]?.resume).toBe(true)
    expect(admitted[0]?.text).toContain(`<workflow-completed run="${RUN_ID}" workflow="demo">`)
  })

  test("a failed admission resolves to error instead of rejecting", async () => {
    const { host } = makeHost({ admit: () => Promise.resolve("error") })
    await expect(hydrateParent(host, SESSION, {
      status: "failed",
      workflow: "demo",
      runId: RUN_ID,
      body: "broke",
    })).resolves.toBe("error")
  })

  test("a throwing host still resolves to error — hydration never breaks a settle", async () => {
    const { host } = makeHost({ admit: () => Promise.reject(new Error("transport down")) })
    await expect(hydrateParent(host, SESSION, {
      status: "completed",
      workflow: "demo",
      runId: RUN_ID,
      body: "v",
    })).resolves.toBe("error")
  })
})

describe("notifyStopped", () => {
  test("uses msg_ultraopen_stop_<runId> and does not resume by default", async () => {
    const { host, admitted } = makeHost()
    await notifyStopped(host, SESSION, RUN_ID, "demo")
    expect(admitted[0]?.id).toBe(`msg_ultraopen_stop_${RUN_ID}`)
    expect(admitted[0]?.resume).toBe(false)
    expect(admitted[0]?.text).toContain(`<workflow-stopped run="${RUN_ID}" workflow="demo">`)
  })

  test("resume: true is passed through for an explicit wake", async () => {
    const { host, admitted } = makeHost()
    await notifyStopped(host, SESSION, RUN_ID, undefined, { resume: true })
    expect(admitted[0]?.resume).toBe(true)
    expect(admitted[0]?.text).toContain(`<workflow-stopped run="${RUN_ID}">`)
  })

  test("a failed delivery never rejects", async () => {
    const { host } = makeHost({ admit: () => Promise.reject(new Error("down")) })
    await expect(notifyStopped(host, SESSION, RUN_ID, "demo")).resolves.toBe("error")
  })
})

describe("deliverOutcomeUnlessStopped — the durable outbox", () => {
  const outcomeOptions = (host: HostPort, overrides: object = {}) => ({
    host,
    coordinator,
    sessionID: SESSION,
    runId: RUN_ID,
    workflow: "demo",
    env,
    ...overrides,
  })

  test("writes the outbox before admission and deletes it after admitted", async () => {
    await seedManifest({ status: "completed" })
    let seenDuringAdmit: string | undefined
    const { host } = makeHost({
      admit: async () => {
        const pending = await readPendingNotification(RUN_ID, env)
        seenDuringAdmit = pending?.id
        return "admitted"
      },
    })
    const result = await deliverOutcomeUnlessStopped(outcomeOptions(host, {
      result: {
        runId: RUN_ID,
        meta: { name: "demo", description: "d" },
        value: "OUTCOME",
        agentCount: 1,
        nulls: [],
        logs: [],
        outputTokens: 0,
        journal: [],
        childSessionIDs: [],
      },
    }))
    expect(result).toBe("admitted")
    expect(seenDuringAdmit).toBe(`msg_ultraopen_outcome_${RUN_ID}`)
    expect(await readPendingNotification(RUN_ID, env)).toBeUndefined()
  })

  test("a failed run writes the failure text and deletes on session-missing", async () => {
    await seedManifest({ status: "failed" })
    const { host, admitted } = makeHost({ admit: () => Promise.resolve("session-missing") })
    const result = await deliverOutcomeUnlessStopped(outcomeOptions(host, { failureText: "it exploded" }))
    expect(result).toBe("session-missing")
    expect(admitted[0]?.text).toContain('<workflow-failed run="wf_bg000001" workflow="demo">')
    expect(admitted[0]?.text).toContain("it exploded")
    expect(await readPendingNotification(RUN_ID, env)).toBeUndefined()
  })

  test("a host error keeps the outbox for the next boot", async () => {
    await seedManifest({ status: "completed" })
    const { host } = makeHost({ admit: () => Promise.resolve("error") })
    await deliverOutcomeUnlessStopped(outcomeOptions(host, { failureText: "x" }))
    expect(await readPendingNotification(RUN_ID, env)).toBeDefined()
  })

  test("a cancelled manifest is never sent and leaves no outbox", async () => {
    await seedManifest({ status: "cancelled" })
    const { host, admitted } = makeHost()
    expect(await deliverOutcomeUnlessStopped(outcomeOptions(host, { failureText: "x" }))).toBe("cancelled")
    expect(admitted).toEqual([])
    await expect(Bun.file(pendingNotificationPath(RUN_ID, env)).exists()).resolves.toBe(false)
  })

  test("a cancel landing after the outbox write deletes it and never admits", async () => {
    const running = await seedManifest()
    let reads = 0
    const { host, admitted } = makeHost()
    const result = await deliverOutcomeUnlessStopped(outcomeOptions(host, {
      failureText: "x",
      readManifestFn: () => {
        reads++
        return Promise.resolve(reads === 1 ? running : { ...running, status: "cancelled" as const })
      },
    }))
    expect(result).toBe("cancelled")
    expect(admitted).toEqual([])
    await expect(Bun.file(pendingNotificationPath(RUN_ID, env)).exists()).resolves.toBe(false)
  })

  test("the title rides the notification's subject line (#142)", async () => {
    await seedManifest({ status: "completed", title: "Fix the login bug" })
    const { host, admitted } = makeHost()
    await deliverOutcomeUnlessStopped(outcomeOptions(host, { failureText: "x", title: "Fix the login bug" }))
    expect(admitted[0]?.text).toContain('title="Fix the login bug"')
    expect(admitted[0]?.description).toBe("Workflow demo failed")
  })
})

describe("stopRun — confirmed settlement", () => {
  beforeEach(async () => {
    await seedManifest()
    await ensureRunDir(RUN_ID, env)
    const snapshot: ProgressSnapshot = {
      runId: RUN_ID,
      workflow: "demo",
      sessionID: SESSION,
      status: "running",
      agents: [],
      logs: [],
      startedAt: 1,
      updatedAt: 1,
      budget: { total: null, spent: 0 },
    }
    await writeFile(progressPath(RUN_ID, env), JSON.stringify(snapshot), "utf8")
  })

  test("a malformed or unknown id is reported as not_found and never touches the host", async () => {
    const { host, interrupted } = makeHost()
    const invalid = await stopRun("wf_../escape", host, coordinator, { env })
    expect(invalid.outcome).toBe("not_found")
    const unknown = await stopRun("wf_nosuch01", host, coordinator, { env })
    expect(unknown.outcome).toBe("not_found")
    expect(interrupted).toEqual([])
  })

  test("a terminal manifest is already_completed or already_stopped", async () => {
    const { host } = makeHost()
    await writeManifest(RUN_ID, manifest({ status: "completed" }), env)
    const completed = await stopRun(RUN_ID, host, coordinator, { env })
    expect(completed.outcome).toBe("already_completed")
    await writeManifest(RUN_ID, manifest({ status: "cancelled" }), env)
    const cancelled = await stopRun(RUN_ID, host, coordinator, { env })
    expect(cancelled.outcome).toBe("already_stopped")
  })

  test("a running manifest with no live record is not_found", async () => {
    const { host } = makeHost()
    const stopped = await stopRun(RUN_ID, host, coordinator, { env })
    expect(stopped.outcome).toBe("not_found")
  })

  test("emits stopping before awaiting child interrupts, then commits cancelled and emits stopped", async () => {
    const { host, interrupted, sequence } = makeHost(),
     live = makeLive({ latestView: view() }),
     emitted: RpcRunView[] = []
    makeProject()
    coordinator.activateLocation(LOCATION, host, {
      emitRunUpdated: (updated) => {
        emitted.push(updated)
        sequence.push(`emit:${updated.status}`)
      },
    })
    live.stopController = new AbortController()
    const child = "ses_child_1"
    coordinator.registerChild(child, {
      runId: RUN_ID,
      projectKey: "project-1",
      parentSessionID: SESSION,
      ancestorSessionIDs: [],
      index: 0,
      label: "one",
      lastActivityAt: 0,
      currentAttempt: 0,
    })
    await writeFile(pendingNotificationPath(RUN_ID, env), JSON.stringify({
      id: `msg_ultraopen_outcome_${RUN_ID}`,
      sessionID: SESSION,
      runId: RUN_ID,
      workflow: "demo",
      status: "completed",
      text: "x",
      description: "Workflow demo completed",
    }), "utf8")

    const result = await stopRun(RUN_ID, host, coordinator, { env })

    expect(result.outcome).toBe("stopped")
    expect(live.stopController.signal.aborted).toBe(true)
    // The RPC state lands BEFORE the child interrupts are awaited.
    expect(sequence.indexOf("emit:stopping")).toBeGreaterThanOrEqual(0)
    expect(sequence.indexOf("emit:stopping")).toBeLessThan(sequence.indexOf("interrupt"))
    expect(interrupted).toEqual([child])
    expect(emitted.map((entry) => entry.status)).toEqual(["stopping", "stopped"])
    // progress.json reports the stop in flight, and the manifest is cancelled.
    const progress = JSON.parse(await readFile(progressPath(RUN_ID, env), "utf8")) as ProgressSnapshot
    expect(progress.status).toBe("stopping")
    expect(await statusAt(RUN_ID, env)).toBe("cancelled")
    await expect(Bun.file(pendingNotificationPath(RUN_ID, env)).exists()).resolves.toBe(false)
  })

  test("admits exactly one workflow-stopped synthetic, keyed by the run, on a confirmed stop (T6b)", async () => {
    const { host, admitted } = makeHost()
    makeLive()
    const result = await stopRun(RUN_ID, host, coordinator, { env })
    expect(result.outcome).toBe("stopped")
    const stops = admitted.filter((entry) => entry.id === `msg_ultraopen_stop_${RUN_ID}`)
    expect(stops).toHaveLength(1)
    expect(stops[0]?.sessionID).toBe(SESSION)
    expect(stops[0]?.resume).toBe(false)
    expect(stops[0]?.text).toContain(`<workflow-stopped run="${RUN_ID}" workflow="demo">`)
  })

  test("admits no stopped synthetic when the run was already stopped", async () => {
    const { host, admitted } = makeHost()
    await writeManifest(RUN_ID, manifest({ status: "cancelled" }), env)
    const result = await stopRun(RUN_ID, host, coordinator, { env })
    expect(result.outcome).toBe("already_stopped")
    expect(admitted).toEqual([])
  })

  test("admits no stopped synthetic when the child shutdown is unconfirmed", async () => {
    const { host, admitted } = makeHost({ interrupt: () => Promise.resolve(false) })
    makeLive()
    coordinator.registerChild("ses_child_1", {
      runId: RUN_ID,
      projectKey: "project-1",
      parentSessionID: SESSION,
      ancestorSessionIDs: [],
      index: 0,
      label: "one",
      lastActivityAt: 0,
      currentAttempt: 0,
    })
    const result = await stopRun(RUN_ID, host, coordinator, { env, interruptTimeoutMs: 50 })
    expect(result.outcome).toBe("stop_failed")
    expect(admitted).toEqual([])
  })

  test("reports already_completed when natural completion won the race and keeps its outbox", async () => {
    const { host } = makeHost()
    makeLive()
    await writeFile(pendingNotificationPath(RUN_ID, env), JSON.stringify({
      id: `msg_ultraopen_outcome_${RUN_ID}`,
      sessionID: SESSION,
      runId: RUN_ID,
      workflow: "demo",
      status: "completed",
      text: "completed while stopping",
      description: "Workflow demo completed",
    }), "utf8")

    const result = await stopRun(RUN_ID, host, coordinator, {
      env,
      markCancelledFn: (standing, children) => Promise.resolve({ ...standing, status: "completed", childSessionIDs: children }),
    })
    expect(result.outcome).toBe("already_completed")
    // Completion owns the settlement; its crash-gap outbox must survive for boot replay.
    expect(await readPendingNotification(RUN_ID, env)).toBeDefined()
  })

  test("an unconfirmed child interrupt is an explicit failure, not a false success", async () => {
    const { host } = makeHost({ interrupt: () => Promise.resolve(false) })
    makeLive()
    coordinator.registerChild("ses_child_1", {
      runId: RUN_ID,
      projectKey: "project-1",
      parentSessionID: SESSION,
      ancestorSessionIDs: [],
      index: 0,
      label: "one",
      lastActivityAt: 0,
      currentAttempt: 0,
    })
    const result = await stopRun(RUN_ID, host, coordinator, { env, interruptTimeoutMs: 50 })
    expect(result.outcome).toBe("stop_failed")
    expect(result.detail).toContain("could not be confirmed")
    expect(await statusAt(RUN_ID, env)).toBe("cancelled")
  })

  test("leaves sibling runs untouched", async () => {
    const { host } = makeHost()
    makeLive()
    const sibling = makeLive({ runId: "wf_sibling1", sessionID: "other" })
    await seedManifest({ runId: "wf_sibling1" })
    await stopRun(RUN_ID, host, coordinator, { env })
    expect(sibling.status).toBe("running")
    expect(await statusAt("wf_sibling1", env)).toBe("running")
  })
})

describe("runDetached — the degraded settle", () => {
  test("an escaping rejection is persisted and counted, not thrown", async () => {
    await seedManifest()
    const seen: unknown[] = []
    await runDetached(coordinator, {
      runId: RUN_ID,
      manifest: await readManifest(RUN_ID, env),
      task: () => Promise.reject(new Error("the failure path broke")),
      renderFailure: () => "degraded failure",
      env,
      onEscapedRejection: (error) => {
        seen.push(error)
        return Promise.resolve()
      },
    })
    expect(seen).toHaveLength(1)
    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toBe("degraded failure")
    expect(await statusAt(RUN_ID, env)).toBe("failed")
  })
})

describe("stopRun — the remaining refusals", () => {
  test("a run owned by another live process is reported as not_found with its pid", async () => {
    await seedManifest({ bootId: "other-boot", pid: process.pid })
    const { host } = makeHost()
    const result = await stopRun(RUN_ID, host, coordinator, { env })
    expect(result.outcome).toBe("not_found")
    expect(result.detail).toContain("another opencode process")
  })

  test("a settle that lands failed while the stop is applied is an explicit stop_failed", async () => {
    await seedManifest()
    const { host } = makeHost()
    makeLive()
    const result = await stopRun(RUN_ID, host, coordinator, {
      env,
      markCancelledFn: (standing, children) => Promise.resolve({ ...standing, status: "failed", childSessionIDs: children }),
    })
    expect(result.outcome).toBe("stop_failed")
    expect(result.detail).toContain('settled with status "failed"')
  })
})

describe("the legacy V1 hydration machinery is gone", () => {
  test("no idle hook export remains", async () => {
    const module = await import("../src/server/tool/background.js")
    expect("onSessionIdle" in module).toBe(false)
    expect("HYDRATION_NOTIFICATION_RE" in module).toBe(false)
  })
})
