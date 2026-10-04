import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wireRun, controlStopRun } from "../src/server/tool/settlement.js"
import { controlPath } from "../src/server/runtime/control.js"
import { ensureRunDir, readManifest, writeManifest } from "../src/server/resume/store.js"
import { resolveOptions } from "../src/server/options.js"
import { registry } from "../src/server/singleton.js"
import { CONTROL_STOP_ABORT_REASON, resetForTests } from "../src/server/tool/background.js"
import type { Manifest } from "../src/server/resume/journal.js"
import type { OpencodeClient } from "../src/server/types.js"

/**
 * The shared run wiring: the settlement module is the ONE place both detached
 * contracts (the launch path's background branch and the boot-time auto-resume
 * sweep) get their flush chain, progress writer, control channel and settle
 * protocol from. These tests pin the wiring that is invisible to the launch
 * suites: the run-control channel notes land in the run's progress log, and
 * settling the run clears the watcher.
 */

const RUN_ID = "wf_settle01",
 SESSION = "ses_wire1",
 SCRIPT = "export const meta = { name: 'wired', description: 'wiring' }\nreturn 'ok'\n"

const client = {
  session: {
    get: () => Promise.resolve({ data: { id: SESSION } }),
    abort: () => Promise.resolve({}),
  },
} as unknown as OpencodeClient

const runningManifest = (): Manifest => ({
  runId: RUN_ID,
  bootId: "boot",
  pid: process.pid,
  sessionID: SESSION,
  sourceHash: "s",
  argsHash: "a",
  args: {},
  status: "running",
  childSessionIDs: [],
  startedAt: Date.now(),
})

const runDirAbs = (): string => join(base, "opencode", "tool-output", "ultraopen", RUN_ID)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {setTimeout(resolve, ms)})

let base: string,
 env: NodeJS.ProcessEnv

const wire = (overrides: Partial<Parameters<typeof wireRun>[0]> = {}): ReturnType<typeof wireRun> => {
  const prepared = { source: SCRIPT, meta: { name: "wired", description: "wiring" }, body: SCRIPT, argsValue: undefined, argsDereference: undefined, argsHydrated: undefined },
   manifest = {
    runId: RUN_ID,
    bootId: "boot",
    pid: process.pid,
    sessionID: SESSION,
    sourceHash: "s",
    argsHash: "a",
    args: {},
    status: "running",
    childSessionIDs: [],
    startedAt: Date.now(),
   } satisfies Manifest
  return wireRun({
    runId: RUN_ID,
    client,
    sessionID: SESSION,
    manifest,
    prepared,
    args: { script: SCRIPT },
    options: resolveOptions({}),
    signal: new AbortController().signal,
    env,
    ...overrides,
  })
}

const flushSnapshot = async (): Promise<{ logs: string[]; agents: unknown[] } | undefined> => {
  try {
    return JSON.parse(await readFile(join(base, "opencode", "tool-output", "ultraopen", RUN_ID, "progress.json"), "utf8")) as { logs: string[]; agents: unknown[] }
  } catch {
    return undefined
  }
}

describe("wireRun", () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "ultraopen-wiring-"))
    env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
    registry.resetForTests()
    resetForTests()
    await ensureRunDir(RUN_ID, env)
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  test("the run-control channel dispatches commands and logs the consumption", async () => {
    // The doc'd contract of watchControl's onNote is the run's progress log; the wiring is what
    // turns a TUI-written control command into something the user can see.
    const dispatches: unknown[] = [],
     wiring = wire()
    await writeManifest(RUN_ID, {
      runId: RUN_ID,
      bootId: "boot",
      pid: process.pid,
      sessionID: SESSION,
      sourceHash: "s",
      argsHash: "a",
      args: {},
      status: "running",
      childSessionIDs: [],
      startedAt: Date.now(),
    }, env)

    wiring.executeContext.registerControl?.((command) => {dispatches.push(command)})
    await writeFile(
      controlPath(join(base, "opencode", "tool-output", "ultraopen", RUN_ID)),
      `${JSON.stringify({ seq: 1, action: "stop-run", run: RUN_ID })}\n`,
      "utf8",
    )

    // The watcher's first tick runs at registration; give the async tick a beat.
    for (let i = 0; i < 200 && dispatches.length === 0; i++) {
      await new Promise((resolve) => {setTimeout(resolve, 10)})
    }
    expect(dispatches).toHaveLength(1)
    // The note reaches the snapshot through the coalesced flush — a timer, not the dispatch —
    // so the assertion must WAIT for it instead of racing the coalescer (the dispatch is
    // event-driven and can land long before the flush timer fires).
    let snapshot: Awaited<ReturnType<typeof flushSnapshot>>
    for (let i = 0; i < 200; i++) {
      snapshot = await flushSnapshot()
      if (snapshot?.logs.some((line) => line.includes("run-control: stop-run"))) {break}
      await new Promise((resolve) => {setTimeout(resolve, 10)})
    }
    expect(snapshot?.logs.some((line) => line.includes("run-control: stop-run"))).toBe(true)

    // Settling clears the watcher: the settled rewrite must never race a late control read.
    await wiring.settle({ status: "completed", entries: [], value: "ok", childSessionIDs: [] })
    const settled = await readManifest(RUN_ID, env)
    expect(settled?.status).toBe("completed")
  })
})

describe("the control-channel stop (#134)", () => {
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "ultraopen-wiring-"))
    env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
    registry.resetForTests()
    resetForTests()
    await ensureRunDir(RUN_ID, env)
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  /** Writes one stop-run command the way the TUI's writeControlCommand does. */
  const writeStopRun = async (): Promise<void> => {
    await writeFile(
      controlPath(runDirAbs()),
      `${JSON.stringify({ seq: 1, action: "stop-run", run: RUN_ID })}\n`,
      "utf8",
    )
  }

  test("the stop-run hook fires through the watcher's dispatch — and only for stop-run", async () => {
    // The wiring's dispatch wrapper is what turns a TUI-written stop-run command into the
    // surface's stop. The engine owns the watcher's start, so this drives wireRun the way
    // the existing dispatch test does, with the hook on a spy.
    const fired: string[] = [],
     dispatches: string[] = [],
     wiring = wire({ onControlStopRun: () => {fired.push("stop")} })
    await writeManifest(RUN_ID, runningManifest(), env)

    wiring.executeContext.registerControl?.((command) => {dispatches.push(command.action)})
    await writeFile(
      controlPath(runDirAbs()),
      `${[
        JSON.stringify({ seq: 1, action: "pause", run: RUN_ID }),
        JSON.stringify({ seq: 2, action: "stop-run", run: RUN_ID }),
      ].join("\n")}\n`,
      "utf8",
    )

    for (let i = 0; i < 200 && dispatches.length < 2; i++) {
      await sleep(10)
    }
    expect(dispatches).toEqual(["pause", "stop-run"])
    // The hook is the stop surface's alone: pause/resume dispatch untouched.
    expect(fired).toEqual(["stop"])
  })

  test("controlStopRun trips the engine with the control reason and records the manifest cancelled", async () => {
    // The unit seam of the TUI stop: snapshot, trip, cancel — mirror of the tool stop's
    // stopRun sequence, asserted the way background.test.ts asserts stopRun's own.
    const manifest = runningManifest()
    await writeManifest(RUN_ID, manifest, env)
    const controller = new AbortController()

    controlStopRun(manifest, controller, env)

    // The trip is synchronous inside the hook; markCancelled's write follows.
    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBe(CONTROL_STOP_ABORT_REASON)
    let settled: Manifest | undefined
    for (let i = 0; i < 200 && (settled = await readManifest(RUN_ID, env))?.status !== "cancelled"; i++) {
      await sleep(10)
    }
    expect(settled?.status).toBe("cancelled")
  })

  test("without a stop surface, a control stop-run dispatches but never trips the engine signal", async () => {
    // The blocking contract wires the same control channel with no stop hook: its stop
    // is aborting the conversation's turn (the tool stop refuses foreground runs), and
    // tripping the tool call's own signal from a control command would fight the host.
    const controller = new AbortController(),
     dispatches: unknown[] = [],
     wiring = wire({ signal: controller.signal })
    await writeManifest(RUN_ID, runningManifest(), env)

    wiring.executeContext.registerControl?.((command) => {dispatches.push(command)})
    await writeStopRun()

    for (let i = 0; i < 200 && dispatches.length === 0; i++) {
      await sleep(10)
    }
    expect(dispatches).toHaveLength(1)
    expect(controller.signal.aborted).toBe(false)
  })
})