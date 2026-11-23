import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDetachedRun, wireRun, controlStopRun } from "../src/server/tool/settlement.js"
import { execute } from "../src/server/tool/workflow.js"
import { controlPath } from "../src/server/runtime/control.js"
import { artifactPaths, ensureRunDir, readJournal, readManifest, writeManifest } from "../src/server/resume/store.js"
import { writeTerminalManifest } from "../src/server/resume/persist.js"
import { resolveOptions } from "../src/server/options.js"
import { CONTROL_STOP_ABORT_REASON, STOP_ABORT_REASON, settlePromiseOf, stopRun } from "../src/server/tool/background.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import type { HostPort, HostTurnResult } from "../src/server/host/port.js"
import type { JournalEntry, Manifest } from "../src/server/resume/journal.js"
import type { PreparedWorkflow, WorkflowResult } from "../src/server/tool/workflow.js"
import type { RpcRunView } from "../src/rpc.js"

/**
 * The shared run wiring: the one place both detached contracts get their flush chain, progress
 * writer, control channel, runUpdated emissions, and settle protocol. These tests pin the wiring
 * the launch suites cannot see: the live view on progress, the terminal view on settlement, the
 * child-list cancel gate, and the durable outbox delivery after the manifest closes.
 */

const RUN_ID = "wf_settle01",
 SESSION = "ses_wire1",
 SCRIPT = "export const meta = { name: 'wired', description: 'wiring' }\nreturn 'ok'\n",
 LOCATION = { directory: "/work", project: { id: "project-1", canonical: "/work" } } as const

let base: string,
 env: NodeJS.ProcessEnv,
 coordinator: RuntimeCoordinator,
 project: ProjectRuntime

const okTurn = (text: string, outputTokens = 0): { ok: true; turn: HostTurnResult } => ({
  ok: true,
  turn: { outcome: "succeeded", text, outputTokens },
})

interface FakeHost {
  host: HostPort
  admitted: { id: string; text: string }[]
  interrupted: string[]
}

const makeHost = (
  options: { interrupt?: ((sessionID: string) => Promise<boolean>) | undefined } = {},
): FakeHost => {
  const admitted: { id: string; text: string }[] = [],
   interrupted: string[] = []
  const host: HostPort = {
    location: { directory: "/work", canonical: "/work", projectID: "project-1" },
    defaultModel: () => Promise.resolve(undefined),
    listModels: () => Promise.resolve([]),
    getSession: () => Promise.resolve(undefined),
    getAgent: () => Promise.resolve(undefined),
    listAgents: () => Promise.resolve([]),
    listPendingPermissions: () => Promise.resolve([]),
    rejectPermission: () => Promise.resolve(),
    createChildSession: () => Promise.resolve({ ok: true, sessionID: "child-created" }),
    moveSession: () => Promise.resolve({ ok: true }),
    runTurn: () => Promise.resolve(okTurn("done")),
    interruptSession: (sessionID) => {
      interrupted.push(sessionID)
      return options.interrupt ? options.interrupt(sessionID) : Promise.resolve(true)
    },
    admitSynthetic: (input) => {
      admitted.push({ id: input.id, text: input.text })
      return Promise.resolve("admitted")
    },
  }
  return { host, admitted, interrupted }
}

const runningManifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  runId: RUN_ID,
  bootId: coordinator.processBootId,
  pid: process.pid,
  sessionID: SESSION,
  projectID: "project-1",
  directory: "/work",
  sourceHash: "s",
  argsHash: "a",
  args: {},
  status: "running",
  childSessionIDs: [],
  startedAt: Date.now(),
  ...overrides,
})

const prepared = (): PreparedWorkflow => ({
  source: SCRIPT,
  meta: { name: "wired", description: "wiring" },
  body: SCRIPT,
  argsValue: undefined,
  argsDereference: undefined,
  argsHydrated: undefined,
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {setTimeout(resolve, ms)})

const statusAt = async (runId: string): Promise<Manifest["status"] | undefined> => {
  const current = await readManifest(runId, env)
  return current?.status
}

const completedResult = (): WorkflowResult => ({
  runId: RUN_ID,
  meta: { name: "wired", description: "wiring" },
  value: "the value",
  agentCount: 1,
  nulls: [],
  logs: [],
  outputTokens: 0,
  journal: [],
  childSessionIDs: [],
})

const waitFor = async (until: () => boolean | Promise<boolean>, what: string, budgetMs = 5000): Promise<void> => {
  const started = Date.now()
  for (;;) {
    if (await until()) {return}
    if (Date.now() - started >= budgetMs) {throw new Error(`timed out waiting for ${what}`)}
    await sleep(10)
  }
}

const wire = (
  host: HostPort,
  overrides: Partial<Parameters<typeof wireRun>[0]> = {},
): ReturnType<typeof wireRun> =>
  wireRun({
    runId: RUN_ID,
    host,
    project,
    coordinator,
    worktreeRoot: "/work",
    sessionID: SESSION,
    manifest: runningManifest(),
    prepared: prepared(),
    args: { script: SCRIPT },
    options: project.options,
    signal: new AbortController().signal,
    env,
    ...overrides,
  })

const flushSnapshot = async (): Promise<{ logs: string[]; status?: string } | undefined> => {
  try {
    return JSON.parse(await readFile(join(base, "opencode", "tool-output", "ultraopen", RUN_ID, "progress.json"), "utf8")) as { logs: string[]; status?: string }
  } catch {
    return undefined
  }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-wiring-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
  resetCoordinatorForTests()
  coordinator = getCoordinator()
  project = coordinator.projectOf(LOCATION, resolveOptions({}))
  await ensureRunDir(RUN_ID, env)
})

afterEach(async () => {
  resetCoordinatorForTests()
  await rm(base, { recursive: true, force: true })
})

describe("wireRun — the control channel", () => {
  test("dispatches commands, logs the consumption, and settles the manifest", async () => {
    const { host } = makeHost(),
     dispatches: unknown[] = [],
     wiring = wire(host)
    await writeManifest(RUN_ID, runningManifest(), env)

    wiring.executeContext.registerControl?.((command) => {dispatches.push(command)})
    await writeFile(
      controlPath(join(base, "opencode", "tool-output", "ultraopen", RUN_ID)),
      `${JSON.stringify({ seq: 1, action: "stop-run", run: RUN_ID })}\n`,
      "utf8",
    )

    await waitFor(() => dispatches.length > 0, "the control-file dispatch")
    expect(dispatches).toHaveLength(1)
    await waitFor(
      async () => {
        const snapshot = await flushSnapshot()
        return snapshot?.logs.some((line) => line.includes("run-control: stop-run")) ?? false
      },
      "the run-control note in the flush snapshot",
    )

    await wiring.settle({ status: "completed", entries: [], value: "ok", childSessionIDs: [] })
    expect(await statusAt(RUN_ID)).toBe("completed")
  })

  test("the stop-run hook fires before dispatch and only for stop-run", async () => {
    const { host } = makeHost(),
     fired: string[] = [],
     dispatches: string[] = [],
     wiring = wire(host, { onControlStopRun: () => {fired.push("stop")} })
    await writeManifest(RUN_ID, runningManifest(), env)

    wiring.executeContext.registerControl?.((command) => {dispatches.push(command.action)})
    await writeFile(
      controlPath(join(base, "opencode", "tool-output", "ultraopen", RUN_ID)),
      `${[
        JSON.stringify({ seq: 1, action: "pause", run: RUN_ID }),
        JSON.stringify({ seq: 2, action: "stop-run", run: RUN_ID }),
      ].join("\n")}\n`,
      "utf8",
    )

    await waitFor(() => dispatches.length >= 2, "the watcher to dispatch both commands")
    expect(dispatches).toEqual(["pause", "stop-run"])
    expect(fired).toEqual(["stop"])
  })
})

describe("wireRun — the child-list rewrite's cancel gate (#156)", () => {
  test("an in-flight child-list rewrite never resurrects running over a cancelled record", async () => {
    const manifest = runningManifest()
    await writeManifest(RUN_ID, manifest, env)
    let releaseRead!: () => void
    const gatedRead = new Promise<void>((resolve) => {releaseRead = resolve})
    let gateOpen = false
    const wiring = wire(makeHost().host, {
      cancelGate: () => gateOpen,
      readManifestFn: async () => {
        await gatedRead
        return manifest
      },
    })
    coordinator.registerChild("ses_child", {
      runId: RUN_ID,
      projectKey: "project-1",
      parentSessionID: SESSION,
      ancestorSessionIDs: [],
      index: 0,
      label: "a",
      lastActivityAt: 0,
      currentAttempt: 0,
    })

    wiring.executeContext.onProgress?.({ type: "agent-start", index: 0, label: "a", phase: undefined })
    await writeManifest(RUN_ID, { ...manifest, status: "cancelled" }, env)
    gateOpen = true
    releaseRead()

    await sleep(50)
    expect(await statusAt(RUN_ID)).toBe("cancelled")
  })

  test("a child-list write carries the terminal-write discipline (#164)", async () => {
    const manifest = runningManifest()
    await writeManifest(RUN_ID, manifest, env)
    let releaseRead!: () => void
    const gatedRead = new Promise<void>((resolve) => {releaseRead = resolve})
    const wiring = wire(makeHost().host, {
      cancelGate: () => false,
      readManifestFn: async () => {
        await gatedRead
        return manifest
      },
    })
    coordinator.registerChild("ses_child", {
      runId: RUN_ID,
      projectKey: "project-1",
      parentSessionID: SESSION,
      ancestorSessionIDs: [],
      index: 0,
      label: "a",
      lastActivityAt: 0,
      currentAttempt: 0,
    })

    wiring.executeContext.onProgress?.({ type: "agent-start", index: 0, label: "a", phase: undefined })
    await writeTerminalManifest(RUN_ID, { ...manifest, status: "cancelled", childSessionIDs: [] }, env)
    releaseRead()
    await waitFor(
      () => readManifest(RUN_ID, env).then((current) => current?.status === "cancelled" && current.childSessionIDs.length === 0),
      "the cancelled record to stand un-resurrected",
    )
  })
})

describe("wireRun — runUpdated emissions", () => {
  test("progress emits a running view; terminal settlement emits the terminal view", async () => {
    const emitted: RpcRunView[] = []
    coordinator.activateLocation(LOCATION, makeHost().host, { emitRunUpdated: (updated) => emitted.push(updated) })
    const wiring = wire(makeHost().host)
    await writeManifest(RUN_ID, runningManifest(), env)

    wiring.executeContext.onProgress?.({ type: "agent-start", index: 0, label: "one", phase: "Review" })
    expect(emitted.at(-1)?.status).toBe("running")
    expect(emitted.at(-1)?.total).toBe(1)

    wiring.executeContext.onProgress?.({ type: "agent-end", index: 0, label: "one", phase: "Review", ok: true, outputTokens: 4 })
    expect(emitted.at(-1)?.done).toBe(1)

    await wiring.settle({ status: "completed", entries: [], value: "ok", childSessionIDs: [] })
    expect(emitted.at(-1)?.status).toBe("completed")
  })

  test("a stop that wins the manifest turns the terminal emission into stopped", async () => {
    const emitted: RpcRunView[] = []
    coordinator.activateLocation(LOCATION, makeHost().host, { emitRunUpdated: (updated) => emitted.push(updated) })
    const wiring = wire(makeHost().host)
    await writeManifest(RUN_ID, runningManifest(), env)
    await writeManifest(RUN_ID, runningManifest({ status: "cancelled" }), env)

    await wiring.settle({ status: "failed", entries: [], value: null, childSessionIDs: [], failureText: "stopped" })
    expect(emitted.at(-1)?.status).toBe("stopped")
  })

  test("an orphaned standing record emits interrupted", async () => {
    const emitted: RpcRunView[] = []
    coordinator.activateLocation(LOCATION, makeHost().host, { emitRunUpdated: (updated) => emitted.push(updated) })
    const wiring = wire(makeHost().host)
    await writeManifest(RUN_ID, runningManifest({ status: "orphaned" }), env)

    await wiring.settle({ status: "completed", entries: [], value: "ok", childSessionIDs: [] })
    expect(emitted.at(-1)?.status).toBe("interrupted")
  })

  test("the engine context reads persisted scripts and flushes the journal", async () => {
    const wiring = wire(makeHost().host),
     scriptPath = join(base, "demo.js")
    await writeManifest(RUN_ID, runningManifest(), env)
    await writeFile(scriptPath, "return 1", "utf8")

    const entry: JournalEntry = {
      type: "result",
      key: "k1",
      scopePath: "root",
      ordinal: 0,
      label: "one",
      status: "ok",
      value: "v",
      outputTokens: 1,
    }
    expect(await wiring.executeContext.readScript?.(scriptPath)).toBe("return 1")
    wiring.executeContext.onJournal?.(entry)
    await wiring.settle({ status: "completed", entries: [entry], value: "ok", childSessionIDs: [] })
    const journal = await readJournal(RUN_ID, env)
    expect(journal).toHaveLength(1)
    expect(journal[0]?.key).toBe("k1")
  })
})

describe("wireRun — the reloadable host proxy", () => {
  const SWAP_SCRIPT = [
    "export const meta = { name: 'swap', description: 'swap' }",
    "await agent('first')",
    "await agent('second')",
    "return 'done'",
  ].join("\n")

  const swapPrepared = (): PreparedWorkflow => ({
    source: SWAP_SCRIPT,
    meta: { name: "swap", description: "swap" },
    body: SWAP_SCRIPT,
    argsValue: undefined,
    argsDereference: undefined,
    argsHydrated: undefined,
  })

  test("a mid-run activateLocation swap routes subsequent Run agent spawns and abortAll to the replacement host", async () => {
    const calls: string[] = [],
     swapping = (label: string, onTurn?: () => void): HostPort => ({
       ...makeHost().host,
       createChildSession: () => {
         calls.push(`${label}:create`)
         return Promise.resolve({ ok: true as const, sessionID: `ses_${label}_${String(calls.length)}` })
       },
       runTurn: () => {
         calls.push(`${label}:turn`)
         onTurn?.()
         return Promise.resolve(okTurn("done"))
       },
       interruptSession: () => {
         calls.push(`${label}:interrupt`)
         return Promise.resolve(true)
       },
     }),
     // Step 1 runs on host1; its turn swaps the activation, so every later host call resolves
     // through the SAME proxy to host2 — including abortAll's interrupts.
     host2 = swapping("h2"),
     host1 = swapping("h1", () => {coordinator.activateLocation(LOCATION, host2)})
    coordinator.activateLocation(LOCATION, host1)
    const proxied = coordinator.hostFor(project.projectKey, LOCATION.directory, host1),
     wiring = wireRun({
       runId: RUN_ID,
       host: proxied,
       project,
       coordinator,
       worktreeRoot: "/work",
       sessionID: SESSION,
       manifest: runningManifest(),
       prepared: swapPrepared(),
       args: { script: SWAP_SCRIPT },
       options: project.options,
       env,
     })

    const result = await execute({ script: SWAP_SCRIPT }, wiring.executeContext)
    await wiring.settle({
      status: "completed",
      entries: result.journal,
      value: result.value,
      childSessionIDs: result.childSessionIDs,
    })

    expect(result.value).toBe("done")
    expect(calls).toEqual(["h1:create", "h1:turn", "h2:create", "h2:turn", "h2:interrupt", "h2:interrupt"])
  })
})

describe("controlStopRun", () => {
  test("trips the engine with the control reason and records the manifest cancelled", async () => {
    const manifest = runningManifest()
    await writeManifest(RUN_ID, manifest, env)
    const controller = new AbortController()

    controlStopRun(manifest, controller, coordinator, env)

    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe(CONTROL_STOP_ABORT_REASON)
    await waitFor(async () => (await statusAt(RUN_ID)) === "cancelled", "the cancelled write")
  })
})

describe("the settle protocol's failure surface (#135)", () => {
  const startGarbledRun = (
    host: HostPort,
    abortWith: ((controller: AbortController) => void) | undefined,
  ): { release: () => void } => {
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    startDetachedRun({
      runId: RUN_ID,
      host,
      project,
      coordinator,
      worktreeRoot: "/work",
      sessionID: SESSION,
      manifest: runningManifest(),
      prepared: prepared(),
      args: { script: SCRIPT },
      options: project.options,
      env,
      executeFn: async (): Promise<never> => {
        await parked
        throw new Error("wave 1 integration failed: null")
      },
    })
    return {
      release: () => {
        if (abortWith !== undefined) {
          const live = coordinator.runs.get(RUN_ID)
          if (live?.stopController === undefined) {throw new Error("no stop controller was registered")}
          abortWith(live.stopController)
        }
        release()
      },
    }
  }

  test("a stopped run's failure.txt names the stop, not the script's garbled template", async () => {
    const { host, admitted } = makeHost()
    const run = startGarbledRun(host, (controller) => {controller.abort(CONTROL_STOP_ABORT_REASON)})
    run.release()
    await settlePromiseOf(coordinator, RUN_ID)

    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toContain("did not fail on its own")
    expect(failure).toContain(`Reason: ${CONTROL_STOP_ABORT_REASON}.`)
    expect(failure).not.toContain("wave 1 integration failed")
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.text).toContain("did not fail on its own")
  })

  test("a tool stop's failure text quotes the bare reason", async () => {
    const { host, admitted } = makeHost()
    const run = startGarbledRun(host, (controller) => {controller.abort(STOP_ABORT_REASON)})
    run.release()
    await settlePromiseOf(coordinator, RUN_ID)

    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toContain("Reason: stopped by request.")
    expect(failure).not.toContain("run-control channel")
    expect(admitted[0]?.text).toContain("Reason: stopped by request.")
  })

  test("a genuine failure's failure.txt renders exactly as before", async () => {
    const { host, admitted } = makeHost()
    const run = startGarbledRun(host, undefined)
    run.release()
    await settlePromiseOf(coordinator, RUN_ID)

    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toContain("wave 1 integration failed: null")
    expect(failure).not.toContain("did not fail on its own")
    expect(admitted[0]?.text).toContain("wave 1 integration failed: null")
  })
})

describe("live view coherence while stopping", () => {
  test("a progress event before markStopping's flush lands emits stopping, never running", async () => {
    const { host } = makeHost(),
     emitted: RpcRunView[] = []
    await writeManifest(RUN_ID, runningManifest(), env)
    coordinator.activateLocation(LOCATION, host, { emitRunUpdated: (updated) => emitted.push(updated) })
    const wiring = wire(host)
    // The stop path has already flipped the live record, but `markStopping`'s flush has not
    // landed, so the writer's own snapshot still says running. This is exactly the interleaved
    // window: an engine progress event arriving here must publish the stop, not revert it.
    coordinator.runs.set(RUN_ID, {
      runId: RUN_ID,
      sessionID: SESSION,
      projectKey: "project-1",
      locationDir: "/work",
      status: "stopping",
      startedAt: Date.now(),
    })

    wiring.executeContext.onProgress?.({ type: "log", message: "still working" })

    expect(emitted.at(-1)?.status).toBe("stopping")
    expect(emitted.map((view) => view.status)).not.toContain("running")
  })

  test("emitRunUpdated updates live.latestView with current agent rows, and progress events after stopRun stay stopping", async () => {
    const { host } = makeHost(),
     emitted: RpcRunView[] = []
    await writeManifest(RUN_ID, runningManifest(), env)
    coordinator.activateLocation(LOCATION, host, { emitRunUpdated: (updated) => emitted.push(updated) })
    let started!: () => void
    const sawStart = new Promise<void>((resolve) => {
      started = resolve
    })
    startDetachedRun({
      runId: RUN_ID,
      host,
      project,
      coordinator,
      worktreeRoot: "/work",
      sessionID: SESSION,
      manifest: runningManifest(),
      prepared: prepared(),
      args: { script: SCRIPT },
      options: project.options,
      env,
      executeFn: async (_args, context) => {
        context.onProgress?.({ type: "agent-start", index: 0, label: "one", phase: "Review" })
        started()
        // Park on the run's own signal, so the stop's abort is what releases the agent — exactly
        // the ordering a real aborted spawn produces.
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted === true) {
            resolve()
            return
          }
          context.signal?.addEventListener("abort", () => {resolve()}, { once: true })
        })
        context.onProgress?.({ type: "agent-end", index: 0, label: "one", phase: "Review", ok: false, reason: "aborted" })
        throw new Error("aborted by request")
      },
    })
    await sawStart
    expect(coordinator.runs.get(RUN_ID)?.latestView?.agents).toHaveLength(1)

    const beforeStop = emitted.length,
     stopPromise = stopRun(RUN_ID, host, coordinator, { env }),
     stoppingAt = async (): Promise<string | undefined> => {
       const snapshot = await flushSnapshot()
       return snapshot?.status
     }
    await waitFor(async () => (await stoppingAt()) === "stopping", "the stopping snapshot on disk")
    await stopPromise
    await settlePromiseOf(coordinator, RUN_ID)

    // Every view emitted after the stop request carries the stop — none reverts to running.
    expect(emitted.length).toBeGreaterThan(beforeStop)
    expect(emitted.slice(beforeStop).map((view) => view.status)).not.toContain("running")
    // The snapshot on disk is the only surface that names the stop in flight; a late progress
    // event must not clobber it back to running.
    expect(await stoppingAt()).toBe("stopping")
  })
})

describe("startDetachedRun — live record, terminal settle and outbox", () => {
  const start = (
    host: HostPort,
    executeFn: Parameters<typeof startDetachedRun>[0]["executeFn"],
    manifest = runningManifest(),
    explain?: (replayed: number) => string,
  ): void => {
    startDetachedRun({
      runId: RUN_ID,
      host,
      project,
      coordinator,
      worktreeRoot: "/work",
      sessionID: SESSION,
      manifest,
      prepared: prepared(),
      args: { script: SCRIPT },
      options: project.options,
      env,
      executeFn,
      ...(explain === undefined ? {} : { explain }),
    })
  }

  test("a completion is hydrated with the deterministic msg id after the manifest closes", async () => {
    const { host, admitted } = makeHost()
    start(host, () => Promise.resolve(completedResult()))
    await settlePromiseOf(coordinator, RUN_ID)

    expect(await statusAt(RUN_ID)).toBe("completed")
    expect(admitted).toHaveLength(1)
    expect(admitted[0]?.id).toBe(`msg_ultraopen_outcome_${RUN_ID}`)
    expect(admitted[0]?.text).toContain('<workflow-completed run="wf_settle01" workflow="wired">')
    expect(admitted[0]?.text).toContain("the value")
    expect(coordinator.runs.has(RUN_ID)).toBe(false)
  })

  test("a titled run's completion subject line carries the title (#142)", async () => {
    const { host, admitted } = makeHost()
    start(host, () => Promise.resolve(completedResult()), runningManifest({ title: "Fix the login bug", description: "The auth flow" }))
    await settlePromiseOf(coordinator, RUN_ID)

    expect(admitted[0]?.text).toContain('<workflow-completed run="wf_settle01" workflow="wired" title="Fix the login bug">')
    expect(admitted[0]?.text).not.toContain("The auth flow")
  })

  test("a titled failure carries the title through the real settle path", async () => {
    const { host, admitted } = makeHost()
    start(host, (): Promise<never> => {
      throw new Error("the script blew up")
    }, runningManifest({ title: "Fix the login bug" }))
    await settlePromiseOf(coordinator, RUN_ID)

    expect(admitted[0]?.text).toContain('<workflow-failed run="wf_settle01" workflow="wired" title="Fix the login bug">')
  })

  test("a hand-edited non-string title degrades to untitled (#142)", async () => {
    const { host, admitted } = makeHost()
    start(host, () => Promise.resolve(completedResult()), runningManifest({ title: 42 as unknown as string }))
    await settlePromiseOf(coordinator, RUN_ID)

    expect(admitted[0]?.text).toContain('<workflow-completed run="wf_settle01" workflow="wired">')
    expect(admitted[0]?.text).not.toContain("title=")
  })

  test("the resumed-run explanation prefixes the notification", async () => {
    const { host, admitted } = makeHost(),
     result = completedResult()
    result.journal = [{
      type: "result",
      key: "k1",
      scopePath: "root",
      ordinal: 0,
      label: "one",
      status: "ok",
      value: "v",
      outputTokens: 1,
      replayed: true,
    }]
    start(host, () => Promise.resolve(result), runningManifest(), (replayed) => `resumed ${replayed} agent(s)`)
    await settlePromiseOf(coordinator, RUN_ID)
    expect(admitted[0]?.text).toContain("resumed 1 agent(s)")
  })

  test("the detached run's control channel trips its own stop surface", async () => {
    const { host } = makeHost()
    await writeManifest(RUN_ID, runningManifest(), env)
    let release!: () => void
    let controlReady!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve}),
     ready = new Promise<void>((resolve) => {controlReady = resolve})
    startDetachedRun({
      runId: RUN_ID,
      host,
      project,
      coordinator,
      worktreeRoot: "/work",
      sessionID: SESSION,
      manifest: runningManifest(),
      prepared: prepared(),
      args: { script: SCRIPT },
      options: project.options,
      env,
      executeFn: async (_args, context) => {
        context.registerControl?.(() => undefined)
        controlReady()
        await parked
        return completedResult()
      },
    })
    await ready
    await writeFile(
      controlPath(join(base, "opencode", "tool-output", "ultraopen", RUN_ID)),
      `${JSON.stringify({ seq: 1, action: "stop-run", run: RUN_ID })}\n`,
      "utf8",
    )
    await waitFor(async () => (await statusAt(RUN_ID)) === "cancelled", "the control stop to cancel the run")
    release()
    await settlePromiseOf(coordinator, RUN_ID)
  })

  test("the live record exists while the run is in flight and exposes the stop controller", async () => {
    const { host } = makeHost()
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    start(host, async () => {
      await parked
      return {
        runId: RUN_ID,
        meta: { name: "wired", description: "wiring" },
        value: "ok",
        agentCount: 0,
        nulls: [],
        logs: [],
        outputTokens: 0,
        journal: [],
        childSessionIDs: [],
      }
    })
    const live = coordinator.runs.get(RUN_ID)
    expect(live?.status).toBe("running")
    expect(live?.stopController).toBeDefined()
    release()
    await settlePromiseOf(coordinator, RUN_ID)
  })
})
