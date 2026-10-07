import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wireRun, startDetachedRun, controlStopRun } from "../src/server/tool/settlement.js"
import { controlPath } from "../src/server/runtime/control.js"
import { artifactPaths, ensureRunDir, readManifest, writeManifest } from "../src/server/resume/store.js"
import { writeTerminalManifest } from "../src/server/resume/persist.js"
import { resolveOptions } from "../src/server/options.js"
import { registry } from "../src/server/singleton.js"
import { CONTROL_STOP_ABORT_REASON, STOP_ABORT_REASON, resetForTests, settlePromiseOf, stopHandleOf } from "../src/server/tool/background.js"
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

/** A client that records every promptAsync, so the hydration body is observable. */
const recordingClient = (): { recording: OpencodeClient; sent: { sessionID: string; text: string }[] } => {
  const sent: { sessionID: string; text: string }[] = []
  return {
    sent,
    recording: {
      session: {
        get: () => Promise.resolve({ data: { id: SESSION } }),
        abort: () => Promise.resolve({}),
        promptAsync: (options: { path: { id: string }; body: { parts: { text: string }[] } }) => {
          sent.push({ sessionID: options.path.id, text: options.body.parts[0]?.text ?? "" })
          return Promise.resolve({ data: undefined })
        },
      },
    } as unknown as OpencodeClient,
  }
}

const preparedFixture = () => ({
  source: SCRIPT,
  meta: { name: "wired", description: "wiring" },
  body: SCRIPT,
  argsValue: undefined,
  argsDereference: undefined,
  argsHydrated: undefined,
})

/** Bounded waiting with a labelled timeout — the wait-instead-of-race idiom (PR #153). */
const waitFor = async (until: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let waited = 0; waited < 600; waited++) {
    if (await until()) {return}
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

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

/** The negative-direction stability idiom: the absence of a resurrection IS the pass, so
 * the assertion polls a bounded window and throws the moment the forbidden state appears.
 * A bare waitFor cannot express "must never happen"; a fixed sleep can false-pass when the
 * clobber lands after it (the PR-#153 wait-instead-of-race rule, negative form). */
async function assertStays(probe: () => Promise<string | undefined>, forbidden: string, what: string): Promise<void> {
  for (let waited = 0; waited < 75; waited++) {
    const current = await probe()
    if (current !== forbidden) {
      throw new Error(`${what}: "${String(current)}" appeared where "${forbidden}" must stay`)
    }
    await sleep(20)
  }
}

describe("the child-list rewrite's cancel gate (#156)", () => {
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

  test("an in-flight child-list rewrite never resurrects running over a cancelled record (#156)", async () => {
    // Found live by the e2e T6b probe: writeChildren checked the cancel gate, then awaited
    // the manifest read; a cancel landing mid-read left the write firing from the stale
    // `running` read — the cancelled record was clobbered back to running, the unwind's
    // endRun then honestly wrote failed over it, and a run the user stopped settled failed.
    // The gate is re-checked after the await.
    const manifest = runningManifest()
    await writeManifest(RUN_ID, manifest, env)

    let releaseRead!: () => void
    const gatedRead = new Promise<void>((resolve) => {releaseRead = resolve})
    let gateOpen = false
    const wiring = wire({
      cancelGate: () => gateOpen,
      readManifestFn: async () => {
        // The read is in flight while the cancel lands.
        await gatedRead
        return manifest
      },
    })

    // A progress event starts writeChildren; its read is now gated mid-flight.
    wiring.executeContext.onProgress?.({ type: "agent-start", index: 0, label: "a", phase: undefined })
    // The stop's cancel lands while the read is outstanding — markCancelled's write won.
    await writeManifest(RUN_ID, { ...manifest, status: "cancelled" }, env)
    gateOpen = true
    releaseRead()

    // The negative direction, waited for instead of slept: a stale rewrite that
    // resurrects running must appear within this bound (a buggy write lands within
    // microseconds of the read's release), and its absence is the pass.
    await assertStays(
      () => readManifest(RUN_ID, env).then((m) => m?.status),
      "cancelled",
      "a stale child-list rewrite resurrected running over the cancelled record",
    )
    // And the cancelled record stands at the bound.
    const standing = await readManifest(RUN_ID, env)
    expect(standing?.status).toBe("cancelled")
  })

  test("a child-list write carries the terminal-write discipline — a cancel that lands mid-flight is never resurrected (#164)", async () => {
    // The wide window the #156 gate cannot close: the gate re-check passes, the stop's
    // cancel lands, and the stale-running write lands after it. A plain rewrite would
    // resurrect running over the cancelled record and legitimize the unwind's later
    // terminal rename; the write's own re-read refuses a record that is no longer running.
    const manifest = runningManifest()
    await writeManifest(RUN_ID, manifest, env)

    let releaseRead!: () => void
    const gatedRead = new Promise<void>((resolve) => {releaseRead = resolve})
    const wiring = wire({
      // The gate NEVER opens: no stop-controller signal is in play, so only the write's
      // own disk discipline can refuse the stale read.
      cancelGate: () => false,
      readManifestFn: async () => {
        await gatedRead
        // The stale `running` read — the cancel has already landed on disk.
        return manifest
      },
    })

    // A progress event starts writeChildren; its read is gated mid-flight.
    wiring.executeContext.onProgress?.({ type: "agent-start", index: 0, label: "a", phase: undefined })
    // The stop's cancel lands while the read is outstanding.
    await writeTerminalManifest(RUN_ID, { ...manifest, status: "cancelled", childSessionIDs: [] }, env)
    releaseRead()
    await waitFor(() => readManifest(RUN_ID, env).then((m) => m?.status === "cancelled" && (m?.childSessionIDs.length ?? 0) === 0), "the cancelled record to stand un-resurrected")

    const standing = await readManifest(RUN_ID, env)
    expect(standing?.status).toBe("cancelled")
    expect(standing?.childSessionIDs).toEqual([])
  })
})

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

    await waitFor(() => dispatches.length >= 2, "the watcher to dispatch both commands")
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
    await waitFor(async () => {
      const settled = await readManifest(RUN_ID, env)
      return settled?.status === "cancelled"
    }, "the cancelled write")
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

    await waitFor(() => dispatches.length > 0, "the watcher to dispatch the stop-run")
    expect(dispatches).toHaveLength(1)
    expect(controller.signal.aborted).toBe(false)
  })
})

describe("the settle protocol's failure surface (#135)", () => {
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

  /**
   * Starts a detached run whose engine parks until the test releases it, then rejects with
   * the corpus shape: the aborted agent's null interpolated into the script's own template
   * string. `abortWith` stops the run through its registered handle before the release,
   * exactly as the stop paths trip the engine.
   */
  const startGarbledRun = (
    recording: OpencodeClient,
    abortWith: ((controller: AbortController) => void) | undefined,
  ): { release: () => void } => {
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    startDetachedRun({
      runId: RUN_ID,
      client: recording,
      sessionID: SESSION,
      manifest: runningManifest(),
      prepared: preparedFixture(),
      args: { script: SCRIPT },
      options: resolveOptions({}),
      env,
      executeFn: async (_args, _ctx): Promise<never> => {
        await parked
        throw new Error("wave 1 integration failed: null")
      },
    })
    return {
      release: () => {
        if (abortWith !== undefined) {
          const handle = stopHandleOf(RUN_ID)
          if (handle === undefined) {throw new Error("no stop handle was registered")}
          abortWith(handle)
        }
        release()
      },
    }
  }

  test("a stopped run's failure.txt names the stop, not the script's garbled template", async () => {
    // The corpus bug: the stop reason reached the journal but never the failure surface,
    // so failure.txt read "wave 1 integration failed: null" for a run the user stopped.
    const { recording, sent } = recordingClient()
    const run = startGarbledRun(recording, (controller) => {controller.abort(CONTROL_STOP_ABORT_REASON)})

    run.release()
    await settlePromiseOf(RUN_ID)

    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toContain("did not fail on its own")
    expect(failure).toContain(`Reason: ${CONTROL_STOP_ABORT_REASON}.`)
    expect(failure).toContain("Completed agents remain on disk for a later resume")
    expect(failure).toContain('<run id="wf_settle01"')
    expect(failure).not.toContain("wave 1 integration failed")
    // The same honesty on the hydration: the corner where a settle beats the cancel write
    // still delivers the failure text — and that text names the stop, never the script.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain("did not fail on its own")
    expect(sent[0]?.text).not.toContain("wave 1 integration failed")
  })

  test("a tool stop's failure text quotes the bare reason — no control-channel provenance", async () => {
    const { recording, sent } = recordingClient()
    const run = startGarbledRun(recording, (controller) => {controller.abort(STOP_ABORT_REASON)})

    run.release()
    await settlePromiseOf(RUN_ID)

    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toContain("Reason: stopped by request.")
    expect(failure).not.toContain("run-control channel")
    expect(failure).not.toContain("wave 1 integration failed")
    expect(sent[0]?.text).toContain("Reason: stopped by request.")
  })

  test("a genuine failure's failure.txt renders exactly as before", async () => {
    // No stop on the signal: the script's own error is the honest text, unchanged.
    const { recording, sent } = recordingClient()
    const run = startGarbledRun(recording, undefined)

    run.release()
    await settlePromiseOf(RUN_ID)

    const failure = await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")
    expect(failure).toContain("wave 1 integration failed: null")
    expect(failure).toContain('<run id="wf_settle01"')
    expect(failure).not.toContain("did not fail on its own")
    expect(sent[0]?.text).toContain("wave 1 integration failed: null")
    expect(sent[0]?.text).not.toContain("did not fail on its own")
  })
})

describe("the settle notification's subject line (#142)", () => {
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

  test("a titled run's completion subject line carries the title beside the workflow name", async () => {
    const { recording, sent } = recordingClient()
    const manifest = { ...runningManifest(), title: "Fix the login bug", description: "The auth flow" }
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    startDetachedRun({
      runId: RUN_ID,
      client: recording,
      sessionID: SESSION,
      manifest,
      prepared: preparedFixture(),
      args: { script: SCRIPT },
      options: resolveOptions({}),
      env,
      executeFn: async () => {
        await parked
        return { runId: RUN_ID, meta: { name: "wired", description: "wiring" }, value: "the value", agentCount: 1, nulls: [], logs: [], outputTokens: 0, journal: [], childSessionIDs: [] }
      },
    })
    release()
    await settlePromiseOf(RUN_ID)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('<workflow-completed run="wf_settle01" workflow="wired" title="Fix the login bug">')
    // The description is manifest-only: no render surface shows it.
    expect(sent[0]?.text).not.toContain("The auth flow")
  })

  test("an untitled run's completion subject line is unchanged", async () => {
    const { recording, sent } = recordingClient()
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    startDetachedRun({
      runId: RUN_ID,
      client: recording,
      sessionID: SESSION,
      manifest: runningManifest(),
      prepared: preparedFixture(),
      args: { script: SCRIPT },
      options: resolveOptions({}),
      env,
      executeFn: async () => {
        await parked
        return { runId: RUN_ID, meta: { name: "wired", description: "wiring" }, value: "the value", agentCount: 1, nulls: [], logs: [], outputTokens: 0, journal: [], childSessionIDs: [] }
      },
    })
    release()
    await settlePromiseOf(RUN_ID)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('<workflow-completed run="wf_settle01" workflow="wired">')
    expect(sent[0]?.text).not.toContain("title=")
  })

  test("a titled run's failure subject line carries the title through the real settle path", async () => {
    // The catch path's deliverOutcomeUnlessStopped reads the title off the same manifest.
    const { recording, sent } = recordingClient()
    const manifest = { ...runningManifest(), title: "Fix the login bug" }
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    startDetachedRun({
      runId: RUN_ID,
      client: recording,
      sessionID: SESSION,
      manifest,
      prepared: preparedFixture(),
      args: { script: SCRIPT },
      options: resolveOptions({}),
      env,
      executeFn: async (): Promise<never> => {
        await parked
        throw new Error("the script blew up")
      },
    })
    release()
    await settlePromiseOf(RUN_ID)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('<workflow-failed run="wf_settle01" workflow="wired" title="Fix the login bug">')
  })

  test("a hand-edited non-string title degrades to untitled — the notification still hydrates (#142)", async () => {
    // hydrateParent swallows render errors, so a throwing render would SILENTLY drop
    // the settle notification; the title must be guarded at the read boundary.
    const { recording, sent } = recordingClient()
    const manifest = { ...runningManifest(), title: 42 as unknown as string }
    let release!: () => void
    const parked = new Promise<void>((resolve) => {release = resolve})
    startDetachedRun({
      runId: RUN_ID,
      client: recording,
      sessionID: SESSION,
      manifest,
      prepared: preparedFixture(),
      args: { script: SCRIPT },
      options: resolveOptions({}),
      env,
      executeFn: async () => {
        await parked
        return { runId: RUN_ID, meta: { name: "wired", description: "wiring" }, value: "the value", agentCount: 1, nulls: [], logs: [], outputTokens: 0, journal: [], childSessionIDs: [] }
      },
    })
    release()
    await settlePromiseOf(RUN_ID)

    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('<workflow-completed run="wf_settle01" workflow="wired">')
    expect(sent[0]?.text).not.toContain("title=")
  })
})
