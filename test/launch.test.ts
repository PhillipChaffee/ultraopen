import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_ANCESTOR_DEPTH, launchWorkflow, nativeAncestorSessionIDs } from "../src/server/tool/launch.js"
import type { LaunchDeps, SavedWorkflow } from "../src/server/tool/launch.js"
import { validateLaunchBoundary, refreshCommandSurface } from "../src/server/tool/launch-gate.js"
import { liveRunsForSession, settlePromiseOf } from "../src/server/tool/background.js"
import { runDir } from "../src/server/resume/store.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { resolveOptions } from "../src/server/options.js"
import type { CreateChildSessionInput, HostPort, HostSessionInfo } from "../src/server/host/port.js"

type SessionRow = Pick<HostSessionInfo, "id"> & { parentID?: string | undefined }

/** Only `getSession` matters to the ancestor walk; the rest of the host is irrelevant here. */
function fakeHost(sessions: Record<string, SessionRow>, throwsOn?: string): HostPort {
  return {
    getSession: (sessionID: string) => {
      if (sessionID === throwsOn) {return Promise.reject(new Error("host read failed"))}
      const row = sessions[sessionID]
      return Promise.resolve(row === undefined ? undefined : (row as HostSessionInfo))
    },
  } as unknown as HostPort
}

describe("nativeAncestorSessionIDs — lineage recorded on a launch", () => {
  test("returns the chain nearest first and stops at the root", async () => {
    const host = fakeHost({
      "s-child": { id: "s-child", parentID: "s-parent" },
      "s-parent": { id: "s-parent", parentID: "s-grand" },
      "s-grand": { id: "s-grand" },
    })
    expect(await nativeAncestorSessionIDs(host, "s-child")).toEqual(["s-parent", "s-grand"])
  })

  test("caps a long chain at the depth limit", async () => {
    const sessions: Record<string, SessionRow> = {}
    for (let index = 0; index < 25; index++) {
      sessions[`s${index}`] = { id: `s${index}`, ...(index === 24 ? {} : { parentID: `s${index + 1}` }) }
    }
    const chain = await nativeAncestorSessionIDs(fakeHost(sessions), "s0")
    expect(chain).toHaveLength(MAX_ANCESTOR_DEPTH)
    expect(chain[0]).toBe("s1")
    expect(chain.at(-1)).toBe(`s${MAX_ANCESTOR_DEPTH}`)
  })

  test("honors an explicit smaller limit", async () => {
    const host = fakeHost({
      a: { id: "a", parentID: "b" },
      b: { id: "b", parentID: "c" },
      c: { id: "c", parentID: "d" },
    })
    expect(await nativeAncestorSessionIDs(host, "a", 2)).toEqual(["b", "c"])
  })

  test("a cycle ends the walk instead of looping", async () => {
    const host = fakeHost({
      a: { id: "a", parentID: "b" },
      b: { id: "b", parentID: "a" },
    })
    expect(await nativeAncestorSessionIDs(host, "a")).toEqual(["b"])
  })

  test("a missing row or a failed host read yields the lineage found so far", async () => {
    expect(await nativeAncestorSessionIDs(fakeHost({}), "s-missing")).toEqual([])
    expect(await nativeAncestorSessionIDs(fakeHost({}, "s-throws"), "s-throws")).toEqual([])
    const host = fakeHost({
      a: { id: "a", parentID: "b" },
      b: { id: "b", parentID: "c" },
    }, "c")
    expect(await nativeAncestorSessionIDs(host, "a")).toEqual(["b", "c"])
  })
})

// ---------------------------------------------------------------------------
// The launch contract: the ancestry the walk above discovers must reach every
// child session the run spawns, on BOTH contracts.
// ---------------------------------------------------------------------------

const SESSION = "parent",
 GRANDPARENT = "grandparent",
 SCRIPT = "export const meta = { name: 'ancestors', description: 'ancestors' }\nawait agent('child')\nreturn 'ok'\n"

let dataHome: string,
 savedDataHome: string | undefined,
 coordinator: RuntimeCoordinator,
 project: ProjectRuntime

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "ultraopen-launch-"))
  savedDataHome = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
})

afterAll(async () => {
  if (savedDataHome === undefined) {delete process.env["XDG_DATA_HOME"]}
  else {process.env["XDG_DATA_HOME"] = savedDataHome}
  await rm(dataHome, { recursive: true, force: true })
})

/** The `metadata.ultraopen.ancestorSessionIDs` every child session creation carries. */
const ancestorsOf = (input: CreateChildSessionInput): readonly string[] | undefined => {
  const ultraopen = input.metadata["ultraopen"]
  if (typeof ultraopen !== "object" || ultraopen === null) {return undefined}
  const ids = (ultraopen as { ancestorSessionIDs?: unknown }).ancestorSessionIDs
  return Array.isArray(ids) ? ids as string[] : undefined
}

/** A host whose session row names one native ancestor above the launching session. */
const makeLaunchHost = (spawned: string[][]): HostPort => {
  const row = (id: string): HostSessionInfo => ({
    id,
    projectID: "project-1",
    directory: "/work",
    agent: "build",
    outputTokens: 0,
    ...(id === SESSION ? { parentID: GRANDPARENT } : {}),
  })
  return {
    location: { directory: "/work", canonical: "/work", projectID: "project-1" },
    defaultModel: () => Promise.resolve(undefined),
    listModels: () => Promise.resolve([]),
    getSession: (sessionID) =>
      Promise.resolve(sessionID === SESSION || sessionID === GRANDPARENT ? row(sessionID) : undefined),
    getAgent: () => Promise.resolve({ id: "build", mode: "primary", hidden: false, permissions: [] }),
    listAgents: () => Promise.resolve([]),
    listPendingPermissions: () => Promise.resolve([]),
    rejectPermission: () => Promise.resolve(),
    createChildSession: (input) => {
      spawned.push([...(ancestorsOf(input) ?? [])])
      return Promise.resolve({ ok: true, sessionID: `ses_child_${spawned.length}` })
    },
    moveSession: () => Promise.resolve({ ok: true }),
    runTurn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "ok", outputTokens: 0 } }),
    interruptSession: () => Promise.resolve(true),
    admitSynthetic: () => Promise.resolve("admitted"),
  }
}

describe("launchWorkflow — native ancestry reaches every child", () => {
  test("launchWorkflow passes native ancestorSessionIDs into blocking and detached runs", async () => {
    resetCoordinatorForTests()
    coordinator = getCoordinator()
    project = coordinator.projectOf(
      { directory: "/work", project: { id: "project-1", canonical: "/work" } },
      resolveOptions({}),
    )
    const blockingAncestry: string[][] = [],
     detachedAncestry: string[][] = [],
     depsOf = (host: HostPort): LaunchDeps => ({
       host,
       project,
       coordinator,
       options: project.options,
       bootId: coordinator.processBootId,
       longLived: false,
       commandState: { entries: [], reload: () => undefined },
       assertPermission: () => Promise.resolve(),
     })

    const blockingOutput = await launchWorkflow(
      { script: SCRIPT, background: false },
      { sessionID: SESSION },
      depsOf(makeLaunchHost(blockingAncestry)),
    )
    expect(blockingAncestry).toEqual([[GRANDPARENT]])
    expect(blockingOutput).toContain("ok")

    const detachedOutput = await launchWorkflow(
      { script: SCRIPT },
      { sessionID: SESSION },
      depsOf(makeLaunchHost(detachedAncestry)),
    )
    const runId = detachedOutput.match(/run="(?<runId>[^"]+)"/u)?.[1]
    if (runId === undefined) {throw new Error(`detached launch reported no run id: ${detachedOutput}`)}
    await settlePromiseOf(coordinator, runId)
    expect(detachedAncestry).toEqual([[GRANDPARENT]])
    resetCoordinatorForTests()
  })
})

describe("validateLaunchBoundary — the launch boundary's refusals", () => {
  test("refuses zero-value decorations, dual sources, and malformed stringified JSON", () => {
    expect(validateLaunchBoundary({ args: "null", script: "x" })).toContain("<workflow-refused>")
    expect(validateLaunchBoundary({ resumeFromRunId: "", script: "x" })).toContain("<workflow-refused>")
    expect(validateLaunchBoundary({ scriptPath: "undefined", script: "x" })).toContain("<workflow-refused>")
    expect(validateLaunchBoundary({ script: "a", scriptPath: "/b.js" })).toContain("<workflow-refused>")
    expect(validateLaunchBoundary({ args: "{bad", script: "x" })).toContain("<workflow-refused>")
    expect(validateLaunchBoundary({ script: "x" })).toBeUndefined()
  })
})

describe("refreshCommandSurface — the saved-workflow command entries", () => {
  test("replaces changed entries with one reload, and a same-signature rescan stays quiet", () => {
    const reloads: string[] = [],
     state: { entries: SavedWorkflow[]; reload: () => void } = {
       entries: [{ name: "stale", description: undefined, source: SCRIPT }],
       reload: () => reloads.push("reload"),
     }

    refreshCommandSurface({ alpha: SCRIPT }, state)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]?.name).toBe("alpha")
    expect(reloads).toHaveLength(1)

    // Same names and sources: the transform must not be asked to reload.
    refreshCommandSurface({ alpha: SCRIPT }, state)
    expect(reloads).toHaveLength(1)

    // A same-named edit is a different signature, so the command refreshes.
    refreshCommandSurface({ alpha: SCRIPT.replace("'ok'", "'ok2'") }, state)
    expect(reloads).toHaveLength(2)
  })
})

describe("launchWorkflow — a denied permission ask", () => {
  test("cleans up the pending entry and pre-ask run dir once, then rethrows the denial", async () => {
    resetCoordinatorForTests()
    coordinator = getCoordinator()
    project = coordinator.projectOf(
      { directory: "/work", project: { id: "project-1", canonical: "/work" } },
      resolveOptions({}),
    )
    const denial = new Error("denied by user"),
     asks: number[] = []
    let askedRunId: string | undefined
    const deps: LaunchDeps = {
      host: makeLaunchHost([]),
      project,
      coordinator,
      options: project.options,
      bootId: coordinator.processBootId,
      longLived: false,
      commandState: { entries: [], reload: () => undefined },
      assertPermission: (input) => {
        asks.push(1)
        askedRunId = typeof input.metadata?.["runId"] === "string" ? input.metadata["runId"] : undefined
        return Promise.reject(denial)
      },
    }

    try {
      // The ORIGINAL denial escapes — a rendered failure or a wrapper would swallow the step signal.
      await expect(launchWorkflow({ script: SCRIPT }, { sessionID: SESSION }, deps)).rejects.toBe(denial)
      expect(asks).toHaveLength(1)
      expect(askedRunId).toBeDefined()
      // The pending entry is gone, and the directory written BEFORE the ask was rolled back.
      expect(liveRunsForSession(coordinator, SESSION)).toEqual([])
      await expect(access(runDir(askedRunId ?? "wf_never0000"))).rejects.toThrow()
    } finally {
      resetCoordinatorForTests()
    }
  })

  test("a failed default-model lookup degrades to no default instead of failing the launch", async () => {
    resetCoordinatorForTests()
    coordinator = getCoordinator()
    project = coordinator.projectOf(
      { directory: "/work", project: { id: "project-1", canonical: "/work" } },
      resolveOptions({}),
    )
    const host: HostPort = {
      ...makeLaunchHost([]),
      defaultModel: () => Promise.reject(new Error("catalog down")),
    }
    const deps: LaunchDeps = {
      host,
      project,
      coordinator,
      options: project.options,
      bootId: coordinator.processBootId,
      longLived: false,
      commandState: { entries: [], reload: () => undefined },
      assertPermission: () => Promise.resolve(),
    }

    try {
      const output = await launchWorkflow({ script: SCRIPT, dryRun: true }, { sessionID: SESSION }, deps)
      expect(output).toContain("<result")
    } finally {
      resetCoordinatorForTests()
    }
  })

  test("the permission ask names the script's phases", async () => {
    resetCoordinatorForTests()
    coordinator = getCoordinator()
    project = coordinator.projectOf(
      { directory: "/work", project: { id: "project-1", canonical: "/work" } },
      resolveOptions({}),
    )
    let phases: unknown
    const deps: LaunchDeps = {
      host: makeLaunchHost([]),
      project,
      coordinator,
      options: project.options,
      bootId: coordinator.processBootId,
      longLived: false,
      commandState: { entries: [], reload: () => undefined },
      assertPermission: (input) => {
        phases = input.metadata?.["phases"]
        return Promise.resolve()
      },
    }
    const phased = "export const meta = { name: 'phased', description: 'p', phases: [{ title: 'Review' }, { title: 'Verify' }] }\nreturn 'ok'\n"

    try {
      await launchWorkflow({ script: phased, dryRun: true }, { sessionID: SESSION }, deps)
      expect(phases).toEqual(["Review", "Verify"])
    } finally {
      resetCoordinatorForTests()
    }
  })
})
