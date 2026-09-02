import { describe, expect, test } from "bun:test"
import { ProgressWriter } from "../src/server/resume/progress.js"
import { RunPoller, activeRuns, dataRoot, formatElapsed, glyph, summarize, toView, type RunView } from "../src/tui/data.js"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const writer = (writes: Array<{ path: string; body: string }>) =>
  new ProgressWriter({
    runId: "wf_abc123",
    workflow: "demo",
    sessionID: "s1",
    startedAt: 1000,
    env: { XDG_DATA_HOME: "/tmp/x" } as NodeJS.ProcessEnv,
    write: (path, body) => {
      writes.push({ path, body })
      return Promise.resolve()
    },
  })

describe("ProgressWriter", () => {
  test("folds agent lifecycle events into the snapshot", () => {
    const progress = writer([])
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: "Find" }, 1100)
    progress.apply({ type: "agent-start", index: 1, label: "b", phase: "Find" }, 1100)
    progress.apply({ type: "agent-end", index: 0, label: "a", phase: "Find", ok: true }, 1200)

    expect(progress.snapshot.agents).toEqual([
      { index: 0, label: "a", phase: "Find", status: "done" },
      { index: 1, label: "b", phase: "Find", status: "running" },
    ])
  })

  test("records a failed agent", () => {
    const progress = writer([])
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: undefined }, 1)
    progress.apply({ type: "agent-end", index: 0, label: "a", phase: undefined, ok: false }, 2)
    expect(progress.snapshot.agents[0]?.status).toBe("failed")
  })

  test("records a REPLAYED agent, which never emits agent-start", () => {
    // Resume satisfies a call from the journal, so only the end event fires. Dropping it would
    // make a resumed run look emptier than it was.
    const progress = writer([])
    progress.apply({ type: "agent-end", index: 3, label: "replayed", phase: "Verify", ok: true }, 5)
    expect(progress.snapshot.agents).toEqual([{ index: 3, label: "replayed", phase: "Verify", status: "done" }])
  })

  test("tracks phase and log narration", () => {
    const progress = writer([])
    progress.apply({ type: "phase", title: "Verify" }, 1)
    progress.apply({ type: "log", message: "fanning out" }, 2)
    expect(progress.snapshot.phase).toBe("Verify")
    expect(progress.snapshot.logs).toEqual(["fanning out"])
    expect(progress.snapshot.updatedAt).toBe(2)
  })

  test("writes only when something changed", async () => {
    const writes: Array<{ path: string; body: string }> = []
    const progress = writer(writes)

    await progress.flush()
    expect(writes.length).toBe(0)

    progress.apply({ type: "log", message: "x" }, 1)
    await progress.flush()
    expect(writes.length).toBe(1)

    await progress.flush()
    expect(writes.length).toBe(1)
  })

  test("a failing write never stalls the run", async () => {
    // Progress is disposable; the journal is the authoritative record.
    const progress = new ProgressWriter({
      runId: "wf_abc123",
      workflow: "d",
      sessionID: "s",
      startedAt: 0,
      write: () => Promise.reject(new Error("disk full")),
    })
    progress.apply({ type: "log", message: "x" }, 1)
    await expect(progress.flush()).resolves.toBeUndefined()
  })

  test("an event folded in during an active write is still flushed afterwards", async () => {
    // Regression: flush() returned immediately when a write was in flight, without rescheduling.
    // If the skipped event was the run's LAST, its final state never reached disk and the TUI
    // showed an agent as running after it had finished.
    let releaseWrite: (() => void) | undefined
    let resolveSecond!: () => void
    const secondWrite = new Promise<void>((resolve) => {
      resolveSecond = resolve
    })
    const writes: string[] = []
    const progress = new ProgressWriter({
      runId: "wf_abc123",
      workflow: "d",
      sessionID: "s",
      startedAt: 0,
      write: async (_path, body) => {
        if (writes.length === 0) {
          // The first write blocks until the test releases it — slow-disk simulation.
          await new Promise<void>((resolve) => {
            releaseWrite = resolve
          })
        }
        writes.push(body)
        if (writes.length === 2) resolveSecond()
      },
    })

    progress.apply({ type: "log", message: "first" }, 1)
    const first = progress.flush()
    await Promise.resolve()
    await Promise.resolve()
    expect(releaseWrite).toBeDefined()

    progress.apply({ type: "log", message: "last" }, 2)
    // Skipped: a write is in flight — this used to lose the event.
    void progress.flush()

    releaseWrite?.()
    await first
    // The chained re-flush (fired from flush's finally) resolves when the second write lands.
    await secondWrite
    expect(writes.length).toBe(2)
    expect(writes[1]).toContain("last")
  })

  test("logs are capped so a chatty run cannot bloat the snapshot", () => {
    const progress = writer([])
    for (let i = 0; i < 500; i++) {
      progress.apply({ type: "log", message: `line ${i}` }, i)
    }
    expect(progress.snapshot.logs.length).toBe(200)
    expect(progress.snapshot.logs.at(-1)).toBe("line 499")
    expect(progress.snapshot.logs[0]).toBe("line 300")
  })

  test("writes into the run directory", async () => {
    const writes: Array<{ path: string; body: string }> = []
    const progress = writer(writes)
    progress.apply({ type: "log", message: "x" }, 1)
    await progress.flush()
    expect(writes[0]?.path).toContain(join("ultraopen", "wf_abc123", "progress.json"))
  })
})

describe("TUI view shaping", () => {
  test("counts done and failed agents", () => {
    const view = toView(
      {
        runId: "wf_a",
        workflow: "demo",
        startedAt: 0,
        agents: [
          { index: 0, label: "a", status: "done" },
          { index: 1, label: "b", status: "failed" },
          { index: 2, label: "c", status: "running" },
        ],
      },
      60_000,
    )
    expect(view.done).toBe(1)
    expect(view.failed).toBe(1)
    expect(view.total).toBe(3)
    expect(view.elapsedSeconds).toBe(60)
  })

  test("tolerates a partially-written snapshot", () => {
    // The file is read while it is being written, so missing fields are normal rather than a bug.
    const view = toView({}, 0)
    expect(view.workflow).toBe("workflow")
    expect(view.agents).toEqual([])
    expect(view.elapsedSeconds).toBe(0)
  })

  test("tolerates a valid agents array containing non-object entries", () => {
    // A hand-edited or corrupt progress.json must degrade to a shorter list, never throw — a
    // throw here would loop on every poll cycle.
    const view = toView(
      {
        runId: "wf_a",
        agents: [
          { index: 0, label: "a", status: "done" },
          null,
          42,
          { label: "no status" },
        ],
        logs: ["ok", 7, null],
      } as unknown as Parameters<typeof toView>[0],
      0,
    )
    expect(view.agents.length).toBe(1)
    expect(view.agents[0]?.label).toBe("a")
    expect(view.total).toBe(1)
    expect(view.logs).toEqual(["ok"])
  })

  test.each([
    [5, "5s"],
    [59, "59s"],
    [60, "1m00s"],
    [252, "4m12s"],
  ])("formats %p seconds as %p", (seconds, expected) => {
    expect(formatElapsed(seconds)).toBe(expected)
  })

  test.each([
    ["done", "✓"],
    ["failed", "✗"],
    ["running", "⠋"],
  ] as const)("uses %p glyph %p", (status, expected) => {
    expect(glyph(status)).toBe(expected)
  })

  test("summarises a run in one line, flagging failures", () => {
    const base = { runId: "r", workflow: "audit", sessionID: "s", agents: [], logs: [], elapsedSeconds: 252 }
    expect(summarize({ ...base, phase: "Verify", done: 6, failed: 0, total: 8 })).toBe("audit · Verify 6/8 · 4m12s")
    expect(summarize({ ...base, done: 6, failed: 2, total: 8 })).toBe("audit · 6/8 · 4m12s · 2 failed")
  })
})

const seed = async (
  root: string,
  runId: string,
  manifest: Record<string, unknown>,
  progress?: Record<string, unknown>,
): Promise<void> => {
  await mkdir(join(root, runId), { recursive: true })
  await writeFile(join(root, runId, "manifest.json"), JSON.stringify(manifest), "utf8")
  if (progress) await writeFile(join(root, runId, "progress.json"), JSON.stringify(progress), "utf8")
}

describe("activeRuns", () => {
  test("returns only running runs for THIS session", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultraopen-tui-"))
    await seed(root, "wf_a", { status: "running", sessionID: "s1" }, { runId: "wf_a", workflow: "mine", startedAt: 0 })
    await seed(root, "wf_b", { status: "completed", sessionID: "s1" }, { runId: "wf_b", startedAt: 0 })
    await seed(root, "wf_c", { status: "running", sessionID: "other" }, { runId: "wf_c", startedAt: 0 })

    const runs = await activeRuns({ root, sessionID: "s1", now: 0 })
    expect(runs.map((run) => run.runId)).toEqual(["wf_a"])
    expect(runs[0]?.workflow).toBe("mine")
  })

  test("skips a run with no progress file yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultraopen-tui-"))
    await seed(root, "wf_a", { status: "running", sessionID: "s1" })
    expect(await activeRuns({ root, sessionID: "s1", now: 0 })).toEqual([])
  })

  test("skips unreadable entries rather than breaking the UI", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultraopen-tui-"))
    await mkdir(join(root, "not-a-run"), { recursive: true })
    await seed(root, "wf_a", { status: "running", sessionID: "s1" }, { runId: "wf_a", startedAt: 0 })
    await writeFile(join(root, "wf_bad", "manifest.json").replace("wf_bad/", ""), "x").catch(() => undefined)

    expect((await activeRuns({ root, sessionID: "s1", now: 0 })).length).toBe(1)
  })

  test("returns nothing when the root does not exist", async () => {
    expect(await activeRuns({ root: "/definitely/not/here", sessionID: "s1", now: 0 })).toEqual([])
  })

  test("orders runs stably so a long run does not jump around", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultraopen-tui-"))
    await seed(root, "wf_zzz", { status: "running", sessionID: "s1" }, { runId: "wf_zzz", startedAt: 0 })
    await seed(root, "wf_aaa", { status: "running", sessionID: "s1" }, { runId: "wf_aaa", startedAt: 0 })
    expect((await activeRuns({ root, sessionID: "s1", now: 0 })).map((run) => run.runId)).toEqual(["wf_aaa", "wf_zzz"])
    await rm(root, { recursive: true, force: true })
  })
})

describe("dataRoot", () => {
  test("agrees with the server half on where runs live", () => {
    expect(dataRoot({ XDG_DATA_HOME: "/data" } as NodeJS.ProcessEnv, "/home/u")).toBe(
      join("/data", "opencode", "tool-output", "ultraopen"),
    )
    expect(dataRoot({} as NodeJS.ProcessEnv, "/home/u")).toBe(
      join("/home/u", ".local", "share", "opencode", "tool-output", "ultraopen"),
    )
  })
})

describe("default write path", () => {
  test("writes a real file when no writer is injected", async () => {
    // The tests above inject a fake writer, which would leave the real file path untested — the
    // one part that actually has to work for the TUI to see anything.
    const base = await mkdtemp(join(tmpdir(), "ultraopen-pw-"))
    const env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
    const dir = join(base, "opencode", "tool-output", "ultraopen", "wf_real01")
    await mkdir(dir, { recursive: true })

    const progress = new ProgressWriter({
      runId: "wf_real01",
      workflow: "demo",
      sessionID: "s1",
      startedAt: 0,
      env,
    })
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: undefined }, 1)
    await progress.flush()

    const written = JSON.parse(await Bun.file(join(dir, "progress.json")).text())
    expect(written.workflow).toBe("demo")
    expect(written.agents.length).toBe(1)
    await rm(base, { recursive: true, force: true })
  })
})

/** A controllable timer, so poller tests are instant and deterministic. */
const fakeTimers = () => {
  const pending: Array<() => void> = []
  const cleared: unknown[] = []
  return {
    api: {
      setInterval: (fn: () => void) => {
        pending.push(fn)
        return pending.length
      },
      clearInterval: (handle: unknown) => {
        cleared.push(handle)
      },
    },
    tick: () => {
      for (const fn of pending.slice()) fn()
    },
    cleared,
  }
}

describe("RunPoller", () => {
  test("with no injected timers, the real interval path works and stops on unsubscribe", async () => {
    // The default timer arrows are the only path the fake-timer tests never reach. A fast real
    // interval proves ticks fire, and that no tick lands after unsubscribe — i.e. cleanup is
    // real, not a no-op.
    const root = "/definitely/not/here"
    const poller = new RunPoller({ root: () => root, pollMs: 5 })
    let calls = 0
    const unsubscribe = poller.subscribe(() => "s1", () => {
      calls++
    })
    try {
      // At least one tick fires while subscribed.
      await Bun.sleep(30)
      const settled = calls
      expect(settled).toBeGreaterThanOrEqual(1)

      unsubscribe()
      await Bun.sleep(30)
      expect(calls).toBe(settled)
    } finally {
      unsubscribe()
    }
  })

  test("one timer serves every subscriber surface, filtered per session", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultraopen-poll-"))
    await seed(root, "wf_a", { status: "running", sessionID: "s1" }, { runId: "wf_a", startedAt: 0 })
    await seed(root, "wf_b", { status: "running", sessionID: "s2" }, { runId: "wf_b", startedAt: 0 })
    const timers = fakeTimers()
    const poller = new RunPoller({ root: () => root, pollMs: 1000, timers: timers.api })

    const mine: RunView[][] = []
    const other: RunView[][] = []
    const unsub1 = poller.subscribe(() => "s1", (runs) => mine.push(runs))
    // The immediate refresh fires at subscribe time.
    await Bun.sleep(5)
    const unsub2 = poller.subscribe(() => "s2", (runs) => other.push(runs))
    await Bun.sleep(5)

    expect(mine.at(-1)?.map((run) => run.runId)).toEqual(["wf_a"])
    expect(other.at(-1)?.map((run) => run.runId)).toEqual(["wf_b"])

    // One interval fires once; BOTH subscribers get fresh data from that single directory pass.
    const mineBefore = mine.length
    const otherBefore = other.length
    timers.tick()
    await Bun.sleep(5)
    expect(mine.length).toBe(mineBefore + 1)
    expect(other.length).toBe(otherBefore + 1)

    // With every surface gone, the interval is cleared and ticking produces no more updates.
    const mineAfter = mine.length
    unsub2()
    unsub1()
    // The one started interval was actually cleared.
    expect(timers.cleared.length).toBe(1)
    timers.tick()
    await Bun.sleep(5)
    expect(mine.length).toBe(mineAfter)
    expect(other.length).toBe(otherBefore + 1)

    await rm(root, { recursive: true, force: true })
  })
})
