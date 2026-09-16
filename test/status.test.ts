import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { executeStatus, MAX_WAIT_SECONDS } from "../src/server/tool/status.js"
import type { StatusDeps } from "../src/server/tool/status.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The status tool reads DISK ONLY. Every test here either injects `readFile` so
 * no filesystem is touched, or seeds a real temp XDG data root and points env
 * at it — which also exercises the default reader and the real runDir layout.
 */

const MANIFEST_RUNNING = {
  runId: "wf_status01",
  bootId: "boot-live",
  pid: 4_242_424,
  sessionID: "parent",
  sourceHash: "h",
  argsHash: "a",
  status: "running" as const,
  childSessionIDs: [],
  startedAt: 1,
}

const entry = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "result",
    key: "k0",
    scopePath: "",
    ordinal: 0,
    label: "a",
    status: "ok",
    outputTokens: 10,
    ...overrides,
  })

const files = (over: Record<string, string> = {}): Record<string, string> => ({
  "manifest.json": JSON.stringify(MANIFEST_RUNNING),
  "progress.json": JSON.stringify({
    runId: "wf_status01",
    workflow: "demo",
    sessionID: "parent",
    phase: "Verify",
    agents: [
      { index: 0, label: "a", status: "done" },
      { index: 1, label: "b", status: "running" },
      { index: 2, label: "c", status: "failed" },
      { index: 3, label: "d", status: "running" },
    ],
    logs: ["one", "two"],
    startedAt: 1,
    updatedAt: 2,
  }),
  "journal.jsonl": [entry(), entry({ key: "k1", label: "b", outputTokens: 5, status: "null" })].join("\n"),
  "result.json": JSON.stringify({ final: "value" }),
  ...over,
})

const fakeReadFile = (over: Record<string, string> = {}) => {
  const store = files(over)
  return (path: string): Promise<string> => {
    const name = path.split("/").pop() ?? ""
    const body = store[name]
    if (body === undefined) {return Promise.reject(new Error(`ENOENT: ${path}`))}
    return Promise.resolve(body)
  }
}

/** A reader that always misses, for the unknown-run path. */
const NEVER_FILES = (_path: string): Promise<string> => Promise.reject(new Error("ENOENT"))

const deps = (over: Record<string, string> = {}): StatusDeps => ({
  env: { XDG_DATA_HOME: "/fake" } as NodeJS.ProcessEnv,
  bootId: "boot-live",
  readFile: fakeReadFile(over),
  isAlive: () => true,
})

const RUN = "wf_status01"

describe("executeStatus — inputs", () => {
  test("a malformed run id is an unknown-run error, never a path traversal", async () => {
    for (const bad of ["../../etc/passwd", "", "not-a-run", "wf_short"]) {
      await expect(executeStatus({ runId: bad }, deps())).rejects.toThrow(/No run found/u)
    }
  })

  test("an unknown id names the directory that was checked", async () => {
    const depsWithoutFiles = { ...deps(), readFile: NEVER_FILES }
    await expect(executeStatus({ runId: "wf_missing01" }, depsWithoutFiles)).rejects.toThrow(/Checked \/fake\/opencode\/tool-output\/ultraopen\/wf_missing01/u)
  })

})

describe("executeStatus — running, completed, failed", () => {
  test("a live run reports counts, tokens, phases and capped logs from disk", async () => {
    const logs = Array.from({ length: 30 }, (_, i) => `line-${i}`)
    const report = await executeStatus({ runId: RUN }, deps({
      "progress.json": JSON.stringify({ agents: [], logs, startedAt: 1, updatedAt: 2, phase: "Find" }),
    }))
    expect(report.status).toBe("running")
    expect(report.agents).toEqual({ total: 0, running: 0, done: 0, failed: 0 })
    expect(report.logs.length).toBe(20)
    expect(report.logs[0]).toBe("line-10")
  })

  test("a completed run carries the final value and only then", async () => {
    const completed = {
      ...deps(),
      readFile: fakeReadFile({
        "manifest.json": JSON.stringify({ ...MANIFEST_RUNNING, status: "completed" }),
        "result.json": JSON.stringify({ answer: 42 }),
      }),
    }
    const report = await executeStatus({ runId: RUN }, completed)
    expect(report.status).toBe("completed")
    expect(report.value).toEqual({ answer: 42 })
  })

  test("a running run never carries a value", async () => {
    const report = await executeStatus({ runId: RUN }, deps())
    expect(report.status).toBe("running")
    expect(report.value).toBeUndefined()
  })

  test("a failed run carries the persisted failure text and the run dir", async () => {
    const manifest = JSON.stringify({ ...MANIFEST_RUNNING, status: "failed" })
    const withFailure = {
      ...deps(),
      readFile: fakeReadFile({ "manifest.json": manifest, "failure.txt": "the script blew up" }),
    }
    const report = await executeStatus({ runId: RUN }, withFailure)
    expect(report.status).toBe("failed")
    expect(report.failure?.message).toBe("the script blew up")
    expect(report.failure?.dir).toContain(RUN)
  })

  test("a failed run without persisted text still explains itself", async () => {
    const manifest = JSON.stringify({ ...MANIFEST_RUNNING, status: "failed" })
    const report = await executeStatus({ runId: RUN }, { ...deps(), readFile: fakeReadFile({ "manifest.json": manifest }) })
    expect(report.status).toBe("failed")
    expect(report.failure?.message).toContain("no failure text was persisted")
  })

  test("an orphaned manifest reports terminal state with a resume pointer", async () => {
    const manifest = JSON.stringify({ ...MANIFEST_RUNNING, status: "orphaned" })
    const report = await executeStatus({ runId: RUN }, { ...deps(), readFile: fakeReadFile({ "manifest.json": manifest }) })
    expect(report.status).toBe("orphaned")
    expect(report.failure?.message).toContain("resumeFromRunId")
  })

  test("a run from a dead other-boot process reports orphaned instead of running forever", async () => {
    // The manifest says running under boot-live, but the observer's boot is
    // different and the pid is gone: this run will never settle.
    const report = await executeStatus(
      { runId: RUN },
      { ...deps(), bootId: "boot-observer", isAlive: () => false },
    )
    expect(report.status).toBe("orphaned")
    expect(report.failure?.message).toContain("died before it could settle")
  })

  test("a run from another LIVE process is still reported running, not dead", async () => {
    const report = await executeStatus(
      { runId: RUN },
      { ...deps(), bootId: "boot-observer", isAlive: () => true },
    )
    expect(report.status).toBe("running")
  })

  test("the value of a completed run with a corrupt result file is undefined, not a crash", async () => {
    const manifest = JSON.stringify({ ...MANIFEST_RUNNING, status: "completed" })
    const report = await executeStatus(
      { runId: RUN },
      { ...deps(), readFile: fakeReadFile({ "manifest.json": manifest, "result.json": "not json" }) },
    )
    expect(report.status).toBe("completed")
    expect(report.value).toBeUndefined()
  })
})

describe("executeStatus — derivations", () => {
  test("output tokens exclude replayed entries and sum the rest", async () => {
    const journal = [
      entry({ outputTokens: 100 }),
      entry({ key: "k1", outputTokens: 0, replayed: true, value: "borrowed" }),
      entry({ key: "k2", outputTokens: 7 }),
    ].join("\n")
    const report = await executeStatus({ runId: RUN }, deps({ "journal.jsonl": journal }))
    // Replayed entries carry ANOTHER run's spend; the total must be this run's.
    expect(report.outputTokens).toBe(107)
    // Idempotence: the same files answer with the same number.
    const again = await executeStatus({ runId: RUN }, deps({ "journal.jsonl": journal }))
    expect(again.outputTokens).toBe(107)
  })

  test("a live phase with no journal entries yet still appears in the phase list", async () => {
    // A phase reaches the journal only when an agent in it completes; the live
    // snapshot's phase must surface before that, or a just-entered phase reads
    // as "(none)" for the whole first leg of the run.
    const report = await executeStatus({ runId: RUN }, deps({ "journal.jsonl": "" }))
    expect(report.phases).toEqual(["Verify"])
  })

  test("phase names come from the journal in first-seen order, plus the live phase", async () => {
    const journal = [
      entry({ phase: "Find" }),
      entry({ key: "k1", phase: "Verify" }),
      entry({ key: "k2", phase: "Find" }),
    ].join("\n")
    const report = await executeStatus({ runId: RUN }, deps({ "journal.jsonl": journal }))
    expect(report.phases).toEqual(["Find", "Verify"])
    expect(report.phase).toBe("Verify")
  })

  test("without a progress snapshot, counts derive from the journal's latest entry per key", async () => {
    const journal = [
      entry({ key: "k0", outputTokens: 3, status: "ok" }),
      entry({ key: "k1", outputTokens: 4, status: "null" }),
      entry({ key: "k2", outputTokens: 5, status: "ok" }),
    ].join("\n")
    const report = await executeStatus({ runId: RUN }, deps({
      "journal.jsonl": journal,
      "progress.json": "not json",
    }))
    expect(report.agents).toEqual({ total: 3, running: 0, done: 2, failed: 1 })
    // A retry that later succeeded counts ONCE, as done: the latest entry wins.
    const retried = [entry({ key: "k0", status: "null", outputTokens: 3 }), entry({ key: "k0", status: "ok", outputTokens: 7 })].join("\n")
    const after = await executeStatus({ runId: RUN }, deps({ "journal.jsonl": retried, "progress.json": "not json" }))
    expect(after.agents).toEqual({ total: 1, running: 0, done: 1, failed: 0 })
    expect(after.outputTokens).toBe(10)
  })

  test("two calls against the same unchanged files return identical token counts", async () => {
    // The no-double-counting criterion: derivation from one read of one file.
    const d = deps()
    const first = await executeStatus({ runId: RUN }, d)
    const second = await executeStatus({ runId: RUN }, d)
    expect(second.outputTokens).toBe(first.outputTokens)
  })

  test("a journal with a torn tail still yields its parseable prefix", async () => {
    const torn = `${entry()}\n{"type":"result","key":"k1","stat`
    const report = await executeStatus({ runId: RUN }, deps({ "journal.jsonl": torn, "progress.json": "not json" }))
    expect(report.agents.total).toBe(1)
    // The torn line contributes nothing, but must not lose the first entry.
    expect(report.outputTokens).toBe(10)
  })
})

describe("executeStatus — wait loop", () => {
  const sleeps: number[] = []

  test("wait is clamped to the 300-second cap on the high side", async () => {
    // A 1000-second ask must sleep for exactly the capped 300 s, not the ask —
    // `wait` is model-supplied input and this clamp is its only bound.
    expect(MAX_WAIT_SECONDS).toBe(300)
    const report = await executeStatus({ runId: RUN, wait: 1000 }, depsWithClock())
    expect(report.status).toBe("running")
    expect(clock).toBe(300_000)
  })

  test("a negative wait collapses to the first snapshot with zero sleeps", async () => {
    const report = await executeStatus({ runId: RUN, wait: -5 }, depsWithClock())
    expect(report.status).toBe("running")
    expect(sleeps.length).toBe(0)
    expect(clock).toBe(0)
  })

  const depsWithClock = (over: Record<string, string> = {}) => ({
    ...deps(over),
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms)
      clock += ms
      return Promise.resolve()
    },
    now: () => clock,
    isAlive: () => true,
  })
  let clock = 0
  beforeEach(() => {
    clock = 0
    sleeps.length = 0
  })

  test("wait polls until the manifest flips to a terminal status", async () => {
    let reads = 0
    const base = files({ "manifest.json": JSON.stringify(MANIFEST_RUNNING) })
    const flipping = (path: string): Promise<string> => {
      const name = path.split("/").pop() ?? ""
      if (name === "manifest.json") {
        reads++
        if (reads > 2) {return Promise.resolve(JSON.stringify({ ...MANIFEST_RUNNING, status: "completed" }))}
      }
      const body = base[name]
      if (body === undefined) {return Promise.reject(new Error("ENOENT"))}
      return Promise.resolve(body)
    }
    const report = await executeStatus({ runId: RUN, wait: 60 }, { ...depsWithClock(), readFile: flipping })
    expect(report.status).toBe("completed")
    expect(sleeps.length).toBeGreaterThan(0)
  })

  test("wait expires into a running snapshot, not an error", async () => {
    const report = await executeStatus({ runId: RUN, wait: 2 }, depsWithClock())
    expect(report.status).toBe("running")
    expect(clock).toBeGreaterThanOrEqual(2000)
  })

  test("an aborted parent turn stops the poll immediately", async () => {
    const controller = new AbortController()
    const pending = executeStatus({ runId: RUN, wait: 60 }, { ...depsWithClock(), signal: controller.signal })
    controller.abort()
    const report = await pending
    expect(report.status).toBe("running")
    expect(sleeps.length).toBe(0)
  })

  test("a zero wait returns the first snapshot without sleeping", async () => {
    const report = await executeStatus({ runId: RUN }, depsWithClock())
    expect(report.status).toBe("running")
    expect(sleeps.length).toBe(0)
  })
})

describe("executeStatus — real disk layout", () => {
  let dataHome: string,
   savedXDG: string | undefined

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "ultraopen-status-"))
    savedXDG = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = dataHome
  })

  afterEach(async () => {
    if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
    else {process.env["XDG_DATA_HOME"] = savedXDG}
    await rm(dataHome, { recursive: true, force: true })
  })

  test("the default reader resolves the real run directory and answers unknown ids", async () => {
    await expect(executeStatus({ runId: "wf_none0000" })).rejects.toThrow(/No run found/u)
  })

  test("default deps poll a real in-flight run and expire the wait honestly", async () => {
    // Seeding a real RUNNING run and asking with wait>0 exercises the default
    // reader, clock and sleep: the module's no-injection path.
    const { beginRun } = await import("../src/server/resume/persist.js")
    const started = Date.now()
    await beginRun({ runId: "wf_real00001", sessionID: "s", source: "x", args: undefined, bootId: "b" })
    const report = await executeStatus({ runId: "wf_real00001", wait: 2 })
    expect(report.status).toBe("running")
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000)
  })
})