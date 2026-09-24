import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wireRun } from "../src/server/tool/settlement.js"
import { controlPath } from "../src/server/runtime/control.js"
import { ensureRunDir, readManifest, writeManifest } from "../src/server/resume/store.js"
import { resolveOptions } from "../src/server/options.js"
import { registry } from "../src/server/singleton.js"
import { resetForTests } from "../src/server/tool/background.js"
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

let base: string,
 env: NodeJS.ProcessEnv

const wire = (overrides: Partial<Parameters<typeof wireRun>[0]> = {}): ReturnType<typeof wireRun> => {
  const prepared = { source: SCRIPT, meta: { name: "wired", description: "wiring" }, body: SCRIPT },
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
    const snapshot = await flushSnapshot()
    expect(snapshot?.logs.some((line) => line.includes("run-control: stop-run"))).toBe(true)

    // Settling clears the watcher: the settled rewrite must never race a late control read.
    await wiring.settle({ status: "completed", entries: [], value: "ok", childSessionIDs: [] })
    const settled = await readManifest(RUN_ID, env)
    expect(settled?.status).toBe("completed")
  })
})