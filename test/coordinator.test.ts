import { beforeEach, describe, expect, test } from "bun:test"
import { resolveOptions } from "../src/server/options.js"
import type { UltraopenOptions } from "../src/server/options.js"
import type { HostPort } from "../src/server/host/port.js"
import {
  getCoordinator,
  resetCoordinatorForTests,
  RuntimeCoordinator,
} from "../src/server/runtime/coordinator.js"
import type {
  ChildSessionRecord,
  LiveRunRecord,
  ProjectLocation,
} from "../src/server/runtime/coordinator.js"
import type { RpcRunView } from "../src/rpc.js"

/** A minimal structural HostPort: the coordinator never calls a host method itself. */
const hostPort = (directory: string, projectID = "proj"): HostPort => ({
  location: { directory, canonical: `/canonical${directory}`, projectID },
  defaultModel: () => Promise.resolve(undefined),
  listModels: () => Promise.resolve([]),
  getSession: () => Promise.resolve(undefined),
  getAgent: () => Promise.resolve(undefined),
  listAgents: () => Promise.resolve([]),
  listPendingPermissions: () => Promise.resolve([]),
  rejectPermission: () => Promise.resolve(undefined),
  createChildSession: () => Promise.resolve({ ok: false, detail: "stub" }),
  moveSession: () => Promise.resolve({ ok: true }),
  runTurn: () => Promise.resolve({ ok: false, detail: "stub" }),
  interruptSession: () => Promise.resolve(false),
  admitSynthetic: () => Promise.resolve("error"),
})

/** A stub host that records which host served each interrupt, prefixed by its label. */
const makeStubHost = (label: string, calls: string[]): HostPort => ({
  ...hostPort("/work"),
  interruptSession: (sessionID) => {
    calls.push(`${label}:${sessionID}`)
    return Promise.resolve(true)
  },
})

const location = (projectID: string, directory: string, canonical = `/canonical${directory}`): ProjectLocation => ({
  directory,
  project: { id: projectID, canonical },
})

const options = (overrides: Partial<UltraopenOptions> = {}): UltraopenOptions => ({
  ...resolveOptions(undefined),
  ...overrides,
})

const liveRun = (
  runId: string,
  projectKey: string,
  locationDir: string,
): LiveRunRecord => ({
  runId,
  sessionID: `ses_${runId}`,
  projectKey,
  locationDir,
  status: "running",
  startedAt: 1,
})

const childRecord = (runId: string, label: string): ChildSessionRecord => ({
  runId,
  projectKey: "proj-a",
  parentSessionID: "ses_parent",
  ancestorSessionIDs: [],
  index: 0,
  label,
  lastActivityAt: 0,
  currentAttempt: 1,
})

/** Runs a real timer: the handoff and disable paths are timer-driven by design. */
const after = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const runView = (runId: string): RpcRunView => ({
  runId,
  workflow: "demo",
  sessionID: `ses_${runId}`,
  status: "running",
  agents: [],
  done: 0,
  failed: 0,
  total: 0,
  startedAt: 1,
})

beforeEach(() => {
  resetCoordinatorForTests()
})

describe("process scope", () => {
  test("getCoordinator returns one instance with one process boot id", () => {
    const first = getCoordinator()
    const second = getCoordinator()
    expect(first).toBe(second)
    expect(first.processBootId).toBe(second.processBootId)
    expect(first.processBootId.length).toBeGreaterThan(0)
  })

  test("the boot id is derived from process facts, not the instance (same-PID reload, #180)", () => {
    const before = getCoordinator().processBootId
    resetCoordinatorForTests()
    expect(getCoordinator().processBootId).toBe(before)
  })

  test("resetForTests yields a clean instance", () => {
    const first = getCoordinator()
    first.runs.set("wf_stale", liveRun("wf_stale", "proj-a", "/dir-a"))
    resetCoordinatorForTests()
    const second = getCoordinator()
    expect(second).not.toBe(first)
    expect(second.runs.size).toBe(0)
  })
})

describe("project keys and isolation", () => {
  test("a non-global project keys on its id; global keys on canonical", () => {
    const coordinator = getCoordinator()
    expect(coordinator.projectKeyOf(location("proj-a", "/work"))).toBe("proj-a")
    expect(coordinator.projectKeyOf(location("global", "/work", "/canonical/work"))).toBe("/canonical/work")
  })

  test("one project, two worktrees: the same ProjectRuntime", () => {
    const coordinator = getCoordinator()
    const main = coordinator.projectOf(location("proj-a", "/repo"))
    const worktree = coordinator.projectOf(location("proj-a", "/repo-wt"))
    expect(main).toBe(worktree)
  })

  test("two projects get independent options, semaphore, and mode", () => {
    const coordinator = getCoordinator()
    const projectA = coordinator.projectOf(location("proj-a", "/a"), options({ concurrency: 3 }))
    const projectB = coordinator.projectOf(location("proj-b", "/b"), options({ concurrency: 6 }))

    expect(projectA).not.toBe(projectB)
    expect(projectA.semaphore).not.toBe(projectB.semaphore)
    expect(projectA.mode).not.toBe(projectB.mode)
    expect(projectA.semaphore.limit).toBe(3)
    expect(projectB.semaphore.limit).toBe(6)

    projectB.options.concurrency = 2
    projectB.semaphore.resize(2)
    projectB.mode.setDefault(true)
    projectB.mode.enable("s1", "command")

    expect(projectA.options.concurrency).toBe(3)
    expect(projectA.semaphore.limit).toBe(3)
    expect(projectA.mode.isActive("s1")).toBe(false)
    expect(projectA.mode.stateOf("s1")).toBeUndefined()
  })

  test("activation applies per-project options and mode defaults", () => {
    const coordinator = getCoordinator()
    coordinator.activateLocation(location("proj-a", "/a"), hostPort("/a"), {
      config: options({ concurrency: 4, ultracode: true }),
    })
    const project = coordinator.projectOf(location("proj-a", "/a"))
    expect(project.semaphore.limit).toBe(4)
    expect(project.mode.isActive("fresh-session")).toBe(true)
  })
})

describe("reload handoff versus explicit disable", () => {
  test("a replacement activation within the grace window adopts live runs and never stops them", async () => {
    const coordinator = getCoordinator()
    const directory = "/dir-a"
    const firstPort = hostPort(directory),
      secondPort = hostPort(directory)
    const first = coordinator.activateLocation(location("proj-a", directory), firstPort)
    const run = liveRun("wf_1", "proj-a", directory)
    coordinator.runs.set(run.runId, run)

    let stopped = 0
    coordinator.deactivateLocation("proj-a", directory, first.generationId, {
      graceMs: 50,
      onDisableStop: () => {
        stopped++
      },
    })
    expect(first.abortController.signal.aborted).toBe(true)

    const second = coordinator.activateLocation(location("proj-a", directory), secondPort)

    // Handoff, not replacement: the run needs no adoption step — its host proxy resolves the
    // current activation, which is now the second one.
    expect(coordinator.projects.get("proj-a")?.activations.get(directory)?.hostPort).toBe(secondPort)
    expect(second.handoffTimer).toBeUndefined()
    expect(first.handoffTimer).toBeUndefined()

    await after(80)
    expect(stopped).toBe(0)
    expect(coordinator.runs.has(run.runId)).toBe(true)
  })

  test("an explicit disable stops only its own (project, location) runs", async () => {
    const coordinator = getCoordinator()
    const portA = hostPort("/dir-a"),
      portB = hostPort("/dir-b")
    const firstA = coordinator.activateLocation(location("proj-a", "/dir-a"), portA)
    coordinator.activateLocation(location("proj-b", "/dir-b"), portB)
    const runA = liveRun("wf_a", "proj-a", "/dir-a"),
      runB = liveRun("wf_b", "proj-b", "/dir-b")
    coordinator.runs.set(runA.runId, runA)
    coordinator.runs.set(runB.runId, runB)

    const stopped: string[] = []
    coordinator.deactivateLocation("proj-a", "/dir-a", firstA.generationId, {
      graceMs: 20,
      onDisableStop: (record) => {
        stopped.push(record.runId)
      },
    })
    await after(60)

    expect(stopped).toEqual(["wf_a"])
    expect(coordinator.runs.has("wf_b")).toBe(true)
  })

  test("a stale cleanup after a newer activation is ignored", async () => {
    const coordinator = getCoordinator()
    const directory = "/dir-a"
    const firstPort = hostPort(directory),
      secondPort = hostPort(directory)
    const first = coordinator.activateLocation(location("proj-a", directory), firstPort)
    const run = liveRun("wf_1", "proj-a", directory)
    coordinator.runs.set(run.runId, run)
    let stopped = 0
    const onDisableStop = (): void => {
      stopped++
    }

    coordinator.deactivateLocation("proj-a", directory, first.generationId, { graceMs: 50, onDisableStop })
    const second = coordinator.activateLocation(location("proj-a", directory), secondPort)

    // The old activation's cleanup lands late: it must not abort or stop the new generation.
    coordinator.deactivateLocation("proj-a", directory, first.generationId, { graceMs: 5, onDisableStop })
    await after(40)

    expect(stopped).toBe(0)
    expect(second.abortController.signal.aborted).toBe(false)
    expect(coordinator.projects.get("proj-a")?.activations.get(directory)?.hostPort).toBe(secondPort)
    expect(coordinator.runs.has(run.runId)).toBe(true)
  })

  test("deactivating an unknown project, location, or generation is a no-op", () => {
    const coordinator = getCoordinator()
    coordinator.deactivateLocation("missing-project", "/nowhere", 1)
    const activation = coordinator.activateLocation(location("proj-a", "/dir-a"), hostPort("/dir-a"))
    coordinator.deactivateLocation("proj-a", "/other-dir", activation.generationId)
    coordinator.deactivateLocation("proj-a", "/dir-a", activation.generationId + 99)
    expect(activation.abortController.signal.aborted).toBe(false)
    // A second cleanup for the generation already deactivating does not re-arm the timer.
    coordinator.deactivateLocation("proj-a", "/dir-a", activation.generationId, { graceMs: 1000 })
    const armed = activation.handoffTimer
    coordinator.deactivateLocation("proj-a", "/dir-a", activation.generationId, { graceMs: 5 })
    expect(activation.handoffTimer).toBe(armed)
  })

  test("emitRunUpdated reaches every activation of that project", () => {
    const coordinator = getCoordinator()
    const views: RpcRunView[] = []
    coordinator.activateLocation(location("proj-a", "/dir-a"), hostPort("/dir-a"), {
      emitRunUpdated: (view) => {
        views.push(view)
      },
    })
    coordinator.activateLocation(location("proj-b", "/dir-b"), hostPort("/dir-b"), {
      emitRunUpdated: () => {
        throw new Error("another project's emitter must not run")
      },
    })

    coordinator.emitRunUpdated("proj-a", runView("wf_1"))
    coordinator.emitRunUpdated("missing-project", runView("wf_2"))
    expect(views.map((view) => view.runId)).toEqual(["wf_1"])
  })
})

describe("child session registry", () => {
  test("tracks ownership, lineage, sessions per run, and activity", () => {
    const coordinator = getCoordinator()
    coordinator.registerChild("ses_child", {
      runId: "wf_1",
      projectKey: "proj-a",
      parentSessionID: "ses_parent",
      ancestorSessionIDs: ["ses_root"],
      index: 0,
      label: "audit",
      lastActivityAt: 5,
      currentAttempt: 1,
    })

    expect(coordinator.owns("ses_child")).toBe(true)
    expect(coordinator.owns("ses_foreign")).toBe(false)
    expect(coordinator.childOf("ses_child")?.label).toBe("audit")
    expect(coordinator.childOf("ses_foreign")).toBeUndefined()
    expect(coordinator.sessionsOf("wf_1")).toEqual(["ses_child"])
    expect(coordinator.sessionsOf("wf_other")).toEqual([])

    coordinator.touchActivity("ses_child", 42)
    expect(coordinator.lastActivity("ses_child")).toBe(42)
    expect(coordinator.lastActivity("ses_foreign")).toBe(0)
    coordinator.touchActivity("ses_foreign", 42)
    expect(coordinator.lastActivity("ses_foreign")).toBe(0)

    coordinator.forgetChild("ses_child")
    expect(coordinator.owns("ses_child")).toBe(false)
  })

  test("forgetRunChildren drops exactly one run's children", () => {
    const coordinator = getCoordinator()
    coordinator.registerChild("ses_a", childRecord("wf_a", "a"))
    coordinator.registerChild("ses_b", childRecord("wf_b", "b"))

    coordinator.forgetRunChildren("wf_a")
    expect(coordinator.sessionsOf("wf_a")).toEqual([])
    expect(coordinator.sessionsOf("wf_b")).toEqual(["ses_b"])
  })
})

describe("event dedupe", () => {
  test("duplicate ids are seen once", () => {
    const coordinator = getCoordinator()
    expect(coordinator.markEventSeen("evt_1")).toBe(true)
    expect(coordinator.markEventSeen("evt_1")).toBe(false)
    expect(coordinator.markEventSeen("evt_2")).toBe(true)
  })

  test("the FIFO holds exactly 8192 ids and evicts the oldest", () => {
    const coordinator = getCoordinator()
    for (let index = 0; index < 8192; index++) {
      expect(coordinator.markEventSeen(`evt_${index}`)).toBe(true)
    }
    expect(coordinator.markEventSeen("evt_0")).toBe(false)
    expect(coordinator.markEventSeen("evt_8192")).toBe(true)
    // evt_0 is the evicted oldest but evt_1 survives until the next insertion.
    expect(coordinator.markEventSeen("evt_1")).toBe(false)
    expect(coordinator.markEventSeen("evt_0")).toBe(true)
  })
})

describe("pending child shells", () => {
  test("matches exact command plus optional cwd, and consumes one token per match", () => {
    const coordinator = getCoordinator()
    coordinator.projectOf(location("proj-a", "/dir-a"))
    const now = 1000
    coordinator.pushPendingShell("proj-a", { command: "ls -la", cwd: "/dir-a", expiresAt: now + 100 })
    coordinator.pushPendingShell("proj-a", { command: "pwd", expiresAt: now + 100 })

    expect(coordinator.consumePendingShell("proj-a", "ls -la", "/dir-b", now)).toBe(false)
    expect(coordinator.consumePendingShell("proj-a", "ls -la", "/dir-a", now)).toBe(true)
    expect(coordinator.consumePendingShell("proj-a", "ls -la", "/dir-a", now)).toBe(false)
    // A token without a cwd matches whatever directory the shell lands in.
    expect(coordinator.consumePendingShell("proj-a", "pwd", "/anywhere", now)).toBe(true)
  })

  test("drops expired tokens and never matches them", () => {
    const coordinator = getCoordinator()
    coordinator.projectOf(location("proj-a", "/dir-a"))
    coordinator.pushPendingShell("proj-a", { command: "late", expiresAt: 100 })
    expect(coordinator.consumePendingShell("proj-a", "late", undefined, 101)).toBe(false)
    // The expired token is gone, so a non-expired duplicate is the one consumed.
    coordinator.pushPendingShell("proj-a", { command: "late", expiresAt: 300 })
    expect(coordinator.consumePendingShell("proj-a", "late", undefined, 150)).toBe(true)
    expect(coordinator.consumePendingShell("proj-a", "late", undefined, 150)).toBe(false)
  })

  test("a token at exactly its expiry still matches; an unknown project has no tokens", () => {
    const coordinator = getCoordinator()
    coordinator.projectOf(location("proj-a", "/dir-a"))
    coordinator.pushPendingShell("proj-a", { command: "edge", expiresAt: 100 })
    expect(coordinator.consumePendingShell("proj-a", "edge", undefined, 100)).toBe(true)
    coordinator.pushPendingShell("proj-a", { command: "edge", expiresAt: 100 })
    expect(coordinator.consumePendingShell("proj-b", "edge", undefined, 50)).toBe(false)
  })
})

describe("the reloadable host proxy", () => {
  test("hostFor routes calls to the replacement activation and falls back to the last live host after disable", async () => {
    const coordinator = new RuntimeCoordinator()
    const calls: string[] = []
    const host1 = makeStubHost("h1", calls)
    const host2 = makeStubHost("h2", calls)
    const loc = { directory: "/work", project: { id: "p1", canonical: "/work" } }
    coordinator.activateLocation(loc, host1)
    const proxy = coordinator.hostFor("p1", "/work", host1)
    await proxy.interruptSession("s1")
    const second = coordinator.activateLocation(loc, host2)
    await proxy.interruptSession("s2")
    coordinator.deactivateLocation("p1", "/work", second.generationId, { graceMs: 5 })
    await after(20)
    await proxy.interruptSession("s3")
    expect(calls).toEqual(["h1:s1", "h2:s2", "h2:s3"])
  })

  test("a mid-arm reload with no proxy call still routes to the replacement host after disable", async () => {
    const coordinator = new RuntimeCoordinator()
    const calls: string[] = []
    const host1 = makeStubHost("h1", calls)
    const host2 = makeStubHost("h2", calls)
    const loc = { directory: "/work", project: { id: "p1", canonical: "/work" } }
    coordinator.activateLocation(loc, host1)
    const proxy = coordinator.hostFor("p1", "/work", host1)
    await proxy.interruptSession("s1")
    // The replacement activation goes live, but this run never calls the proxy during it. Only the
    // coordinator's last-registered port can know the replacement existed once it is disabled.
    const second = coordinator.activateLocation(loc, host2)
    coordinator.deactivateLocation("p1", "/work", second.generationId, { graceMs: 5 })
    await after(20)
    await proxy.interruptSession("s2")
    expect(calls).toEqual(["h1:s1", "h2:s2"])
  })

  test("hostFor delegates every port method and its location to the resolved host", async () => {
    const coordinator = new RuntimeCoordinator()
    const seen: string[] = []
    const live: HostPort = {
      location: { directory: "/work", canonical: "/work", projectID: "p1" },
      defaultModel: () => {
        seen.push("defaultModel")
        return Promise.resolve(undefined)
      },
      listModels: () => {
        seen.push("listModels")
        return Promise.resolve([])
      },
      getSession: () => {
        seen.push("getSession")
        return Promise.resolve(undefined)
      },
      getAgent: () => {
        seen.push("getAgent")
        return Promise.resolve(undefined)
      },
      listAgents: () => {
        seen.push("listAgents")
        return Promise.resolve([])
      },
      listPendingPermissions: () => {
        seen.push("listPendingPermissions")
        return Promise.resolve([])
      },
      rejectPermission: () => {
        seen.push("rejectPermission")
        return Promise.resolve()
      },
      createChildSession: () => {
        seen.push("createChildSession")
        return Promise.resolve({ ok: false as const, detail: "stub" })
      },
      moveSession: () => {
        seen.push("moveSession")
        return Promise.resolve({ ok: true as const })
      },
      runTurn: () => {
        seen.push("runTurn")
        return Promise.resolve({ ok: false as const, detail: "stub" })
      },
      interruptSession: () => {
        seen.push("interruptSession")
        return Promise.resolve(false)
      },
      admitSynthetic: () => {
        seen.push("admitSynthetic")
        return Promise.resolve("error" as const)
      },
    }
    const proxy = coordinator.hostFor("p1", "/work", live)

    expect(proxy.location).toEqual(live.location)
    await proxy.defaultModel()
    await proxy.listModels()
    await proxy.getSession("s1")
    await proxy.getAgent("build", "/work")
    await proxy.listAgents("/work")
    await proxy.listPendingPermissions("s1")
    await proxy.rejectPermission("s1", "per_1", "no")
    await proxy.createChildSession({ title: "t", metadata: {} })
    await proxy.moveSession("s1", "/work")
    await proxy.runTurn({ sessionID: "s1", messageID: "msg_1", text: "go" })
    await proxy.interruptSession("s1")
    await proxy.admitSynthetic({ sessionID: "s1", id: "msg_1", text: "go" })

    expect(seen).toEqual([
      "defaultModel",
      "listModels",
      "getSession",
      "getAgent",
      "listAgents",
      "listPendingPermissions",
      "rejectPermission",
      "createChildSession",
      "moveSession",
      "runTurn",
      "interruptSession",
      "admitSynthetic",
    ])
  })
})

describe("boot sweep", () => {
  test("runs once per boot id and hands every caller the same promise", async () => {
    const coordinator = getCoordinator()
    let calls = 0
    const first = coordinator.runBootSweepOnce(() => {
      calls++
    })
    const second = coordinator.runBootSweepOnce(() => {
      calls++
    })
    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  test("bootSweepSettled waits for every tracked full sweep and swallows its rejection", async () => {
    const coordinator = new RuntimeCoordinator()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    coordinator.trackBootSweep(gate)
    let settled = false
    const waiting = coordinator.bootSweepSettled().then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)

    release()
    await waiting
    expect(settled).toBe(true)

    const failing = new RuntimeCoordinator()
    failing.trackBootSweep(Promise.reject(new Error("resume boom")))
    await expect(failing.bootSweepSettled()).resolves.toBeUndefined()
  })

  test("a sweep tracked while bootSweepSettled is waiting is awaited too", async () => {
    const coordinator = new RuntimeCoordinator()
    let releaseFirst!: () => void,
     releaseSecond!: () => void
    const first = new Promise<void>((resolve) => {
       releaseFirst = resolve
     }),
     second = new Promise<void>((resolve) => {
       releaseSecond = resolve
     })
    coordinator.trackBootSweep(first)
    let settled = false
    const waiting = coordinator.bootSweepSettled().then(() => (settled = true))
    await Promise.resolve()

    // A second project boots while the first call is already waiting.
    coordinator.trackBootSweep(second)
    releaseFirst()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseSecond()
    await waiting
    expect(settled).toBe(true)
  })
})
