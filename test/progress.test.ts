import { describe, expect, test } from "bun:test"
import { ProgressWriter } from "../src/server/resume/progress.js"
import { LARGE_RUN_AGENTS } from "../src/server/script/limits.js"
import { agentRowText, formatElapsed, glyph, hintLine, stripAgentText, summarize, transcriptHint } from "../src/tui/data.js"
import type { RunView } from "../src/tui/data.js"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const writer = (writes: { path: string; body: string }[]) =>
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

const budgetWriter = (
  writes: { path: string; body: string }[],
  budgetTotal: number | null,
) =>
  new ProgressWriter({
    runId: "wf_abc123",
    workflow: "demo",
    sessionID: "s1",
    startedAt: 1000,
    budgetTotal,
    env: { XDG_DATA_HOME: "/tmp/x" } as NodeJS.ProcessEnv,
    write: (path, body) => {
      writes.push({ path, body })
      return Promise.resolve()
    },
  })

describe("ProgressWriter — budget", () => {
  test("the snapshot always carries the budget shape, uncapped by default", () => {
    // A stable shape: the sidebar reads total/spent without optionality gymnastics, and an
    // uncapped run still reports its spend.
    const progress = writer([])
    expect(progress.snapshot.budget).toEqual({ total: null, spent: 0 })
  })

  test("budgetTotal passes the ceiling through", () => {
    const progress = budgetWriter([], 50_000)
    expect(progress.snapshot.budget).toEqual({ total: 50_000, spent: 0 })
  })

  test("spent accumulates from agent-end events, including replayed calls", () => {
    // Replayed agents carry their recorded spend as if paid — the same way the run's own
    // budget.spent() counts them, so the snapshot and the script's budget global agree.
    const progress = budgetWriter([], 1000)
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: undefined }, 1)
    progress.apply({ type: "agent-end", index: 0, label: "a", phase: undefined, ok: true, outputTokens: 300 }, 2)
    progress.apply({ type: "agent-end", index: 1, label: "b", phase: undefined, ok: true, outputTokens: 250 }, 3)
    expect(progress.snapshot.budget).toEqual({ total: 1000, spent: 550 })
  })

  test("a failed agent contributes its zero spend, keeping the total journal-shaped", () => {
    const progress = budgetWriter([], 1000)
    progress.apply({ type: "agent-end", index: 0, label: "a", phase: undefined, ok: false, outputTokens: 0 }, 1)
    expect(progress.snapshot.budget.spent).toBe(0)
  })
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

  test("agent-session stamps the running row with its child's session id (#150)", () => {
    const progress = writer([])
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: "Verify" }, 1)
    progress.apply({ type: "agent-session", index: 0, sessionID: "ses_child_0" }, 2)
    expect(progress.snapshot.agents).toEqual([
      { index: 0, label: "a", phase: "Verify", status: "running", sessionID: "ses_child_0" },
    ])
  })

  test("an idle deadline's stall restart re-stamps the row with the new child's id", () => {
    // The restart re-fires agent-session for the same index; the row carries the CURRENT
    // child, and both sessions belong to the same agent recording.
    const progress = writer([])
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: "Verify" }, 1)
    progress.apply({ type: "agent-session", index: 0, sessionID: "ses_child_old" }, 2)
    progress.apply({ type: "agent-session", index: 0, sessionID: "ses_child_new" }, 3)
    expect(progress.snapshot.agents).toEqual([
      { index: 0, label: "a", phase: "Verify", status: "running", sessionID: "ses_child_new" },
    ])
  })

  test("agent-session before any agent-start folds nothing — the row does not become invented", () => {
    // A session without a schedule row is not an agent the run started; the fold waits for
    // agent-start (or an end event) to name the agent properly.
    const progress = writer([])
    progress.apply({ type: "agent-session", index: 9, sessionID: "ses_orphan" }, 1)
    expect(progress.snapshot.agents).toEqual([])
  })

  test("agent-end carries the session id through to a settled row, and a replayed one carries none", () => {
    const progress = writer([])
    progress.apply({ type: "agent-start", index: 0, label: "a", phase: undefined }, 1)
    progress.apply({ type: "agent-end", index: 0, label: "a", phase: undefined, ok: true, outputTokens: 5, sessionID: "ses_child_0" }, 2)
    progress.apply({ type: "agent-end", index: 1, label: "replayed", phase: undefined, ok: true }, 3)
    expect(progress.snapshot.agents).toEqual([
      { index: 0, label: "a", phase: undefined, status: "done", outputTokens: 5, sessionID: "ses_child_0" },
      { index: 1, label: "replayed", phase: undefined, status: "done" },
    ])
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
    const writes: { path: string; body: string }[] = [],
     progress = writer(writes)

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
    let releaseWrite: (() => void) | undefined,
     resolveSecond!: () => void
    const secondWrite = new Promise<void>((resolve) => {
      resolveSecond = resolve
    }),
     writes: string[] = [],
     progress = new ProgressWriter({
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
        if (writes.length === 2) {resolveSecond()}
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
    const writes: { path: string; body: string }[] = [],
     progress = writer(writes)
    progress.apply({ type: "log", message: "x" }, 1)
    await progress.flush()
    expect(writes[0]?.path).toContain(join("ultraopen", "wf_abc123", "progress.json"))
  })
})

describe("ProgressWriter — stopping state (#175)", () => {
  test("a live snapshot reports running by default", () => {
    expect(writer([]).snapshot.status).toBe("running")
  })

  test("markStopping(now) flips the snapshot to stopping and flushes it", async () => {
    const writes: { path: string; body: string }[] = [],
     progress = writer(writes)
    progress.apply({ type: "log", message: "before the stop" }, 1)
    await progress.flush()

    await progress.markStopping(1234)

    expect(progress.snapshot.status).toBe("stopping")
    expect(progress.snapshot.updatedAt).toBe(1234)
    // The mark itself flushes: a stop request that only lived in memory would leave the
    // TUI and the status tool reading a stale running snapshot.
    expect(writes.length).toBe(2)
    const written = JSON.parse(writes[1]?.body ?? "{}") as { status?: string }
    expect(written.status).toBe("stopping")
  })

  test("markStopping on an unchanged writer still writes, so the request is observable", async () => {
    const writes: { path: string; body: string }[] = [],
     progress = writer(writes)
    await progress.markStopping(9)
    expect(writes.length).toBe(1)
    expect(JSON.parse(writes[0]?.body ?? "{}")).toMatchObject({ status: "stopping", updatedAt: 9 })
  })

  test("markStopping waits for a flush already in flight before it resolves", async () => {
    // Regression: flush() used to return immediately when a write was in flight. markStopping
    // awaited that no-op, resolved, and the stop path emitted `stopped` while `progress.json` still
    // said `running` — until the in-flight write happened to land.
    let releaseWrite!: () => void
    const gate = new Promise<void>((resolve) => {
       releaseWrite = resolve
     }),
     writes: string[] = [],
     progress = new ProgressWriter({
       runId: "wf_abc123",
       workflow: "d",
       sessionID: "s",
       startedAt: 0,
       write: async (_path, body) => {
         // The FIRST write blocks on the gate; later writes land immediately.
         if (writes.length === 0 && releaseWrite !== undefined) {await gate}
         writes.push(body)
       },
     })

    progress.apply({ type: "log", message: "before" }, 1)
    const inFlight = progress.flush()
    await Promise.resolve()
    const stopping = progress.markStopping(2)
    let resolved = false
    void stopping.then(() => (resolved = true))
    await Promise.resolve()
    await Promise.resolve()
    // Still blocked behind the earlier write: `stopping` is not on disk yet.
    expect(resolved).toBe(false)
    expect(writes).toEqual([])

    releaseWrite()
    await inFlight
    await stopping
    // The drain loop wrote the FIRST snapshot, then re-checked `#dirty` and wrote `stopping`.
    expect(writes.length).toBe(2)
    expect(JSON.parse(writes[1] ?? "{}")).toMatchObject({ status: "stopping", updatedAt: 2 })
  })
})

describe("TUI view shaping", () => {
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

  test("agent rows state the child session id where the snapshot carries one (#150)", () => {
    expect(agentRowText({ index: 0, label: "a", status: "running", sessionID: "ses_child_0" })).toBe("⠋ a · ses_child_0")
    // A settled row keeps both its spend and its child id.
    expect(agentRowText({ index: 0, label: "a", status: "done", outputTokens: 1500, sessionID: "ses_child_0" })).toBe("✓ a · 1.5k · ses_child_0")
    // A replayed agent has no child to name — nothing is invented.
    expect(agentRowText({ index: 0, label: "a", status: "done" })).toBe("✓ a")
  })

  test("the strip's compact rows carry the id and nothing else — identification, not explanation", () => {
    expect(stripAgentText({ index: 0, label: "a", status: "failed", reason: "api-error", outputTokens: 999, sessionID: "ses_child_0" })).toBe("✗ a · ses_child_0")
    expect(stripAgentText({ index: 0, label: "a", status: "running" })).toBe("⠋ a")
  })

  test("the transcript hint names the V2 affordances without positional claims (#150)", () => {
    const hint = transcriptHint()
    expect(hint).toContain("/workflows")
    expect(hint).toContain("clickable")
    expect(hint).toContain("/sessions")
    expect(hint).toContain("ultraopen · <label>")
    expect(hint).not.toContain("leader+down")
    expect(hint).not.toMatch(/row \d/u)
    expect(hint).not.toContain("child 2")
  })
})

describe("hintLine — the interrupted-run affordance", () => {
  test("names the workflow, the run id, and the resume path", () => {
    expect(hintLine({ runId: "wf_orphan01", workflow: "research" })).toBe(
      "interrupted: research (wf_orphan01) — ask to resume it",
    )
  })
})

describe("default write path", () => {
  test("writes a real file when no writer is injected", async () => {
    // The tests above inject a fake writer, which would leave the real file path untested — the
    // one part that actually has to work for the TUI to see anything.
    const base = await mkdtemp(join(tmpdir(), "ultraopen-pw-")),
     env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv,
     dir = join(base, "opencode", "tool-output", "ultraopen", "wf_real01")
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
    expect(written.budget).toEqual({ total: null, spent: 0 })
    await rm(base, { recursive: true, force: true })
  })
})

describe("agentRowText", () => {
  test("failed rows carry the reason; other rows do not", () => {
    expect(agentRowText({ index: 0, label: "a", status: "failed", reason: "deadline" })).toBe("✗ a — deadline")
    expect(agentRowText({ index: 0, label: "a", status: "failed" })).toBe("✗ a")
    expect(agentRowText({ index: 0, label: "a", status: "done" })).toBe("✓ a")
  })
})

const runView = (total: number): RunView => ({
  runId: "wf_a",
  workflow: "demo",
  sessionID: "s1",
  agents: [],
  done: 0,
  failed: 0,
  total,
  elapsedSeconds: 0,
  logs: [],
})

describe("large-run badge in the strip summary", () => {
  test("a run at or above the threshold is flagged as a large run", () => {
    expect(summarize(runView(LARGE_RUN_AGENTS))).toContain("· large run")
  })

  test("a small run carries no badge", () => {
    expect(summarize(runView(1))).not.toContain("large run")
  })
})

describe("ProgressWriter — atomic flush (#136)", () => {
  test("a killed DEFAULT flush leaves the previous snapshot whole, no temp behind", async () => {
    // Discriminator for the regressable path: every test above injects a fake writer, so they all
    // pass even if the default flush were a plain truncate-write — the killed-write guarantee then
    // rests on nothing. Here no `write` is supplied, so the DEFAULT flush runs; the inject object
    // is shared by reference so one writer can land v1 normally and then attempt v2 with the rename
    // failing — the exact killed-mid-write shape. A non-atomic default replaces the file (test
    // fails); the atomic one fails before touching the target, so v1 survives whole.
    const root = await mkdtemp(join(tmpdir(), "ultraopen-progress-")),
      env = { XDG_DATA_HOME: root } as NodeJS.ProcessEnv,
      dir = join(root, "opencode", "tool-output", "ultraopen", "wf_prog02")
    try {
      await mkdir(dir, { recursive: true })
      const inject = { failRename: false }
      const flusher = new ProgressWriter({ runId: "wf_prog02", workflow: "w", sessionID: "s", startedAt: 1, env, inject })
      flusher.apply({ type: "log", message: "v1" }, 2)
      await flusher.flush()
      inject.failRename = true
      flusher.apply({ type: "log", message: "v2" }, 3)
      await flusher.flush()
      const survived = JSON.parse(await readFile(join(dir, "progress.json"), "utf8"))
      expect(survived.logs).toEqual(["v1"])
      expect(await readdir(dir).then((e) => e.filter((n) => n.includes(".tmp")))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a torn progress file is repaired by the next flush; flushes leave no temp file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ultraopen-progress-"))
    const env = { XDG_DATA_HOME: root } as NodeJS.ProcessEnv
    try {
      await mkdir(join(root, "opencode", "tool-output", "ultraopen", "wf_prog01"), { recursive: true })
      await writeFile(join(root, "opencode", "tool-output", "ultraopen", "wf_prog01", "progress.json"), "{torn", "utf8")
      const flusher = new ProgressWriter({ runId: "wf_prog01", workflow: "w", sessionID: "s", startedAt: 1, env })
      flusher.apply({ type: "log", message: "one" }, 2)
      await flusher.flush()
      const snap = JSON.parse(await readFile(join(root, "opencode", "tool-output", "ultraopen", "wf_prog01", "progress.json"), "utf8"))
      expect(snap.logs).toEqual(["one"])
      const entries = await readdir(join(root, "opencode", "tool-output", "ultraopen", "wf_prog01"))
      expect(entries.filter((e) => e.includes(".tmp"))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("ProgressWriter — default flush atomicity (#136 review)", () => {
  test("a default flush that dies between the temp write and the rename leaves the previous snapshot whole", async () => {
    // The discriminator: under a non-atomic default (truncate + die mid-write) the previous
    // snapshot is destroyed; the atomic flush fails BEFORE touching the target, so v1 survives.
    const root = await mkdtemp(join(tmpdir(), "ultraopen-progress-"))
    const env = { XDG_DATA_HOME: root } as NodeJS.ProcessEnv
    try {
      await mkdir(join(root, "opencode", "tool-output", "ultraopen", "wf_prog01"), { recursive: true })
      const baseline = new ProgressWriter({ runId: "wf_prog01", workflow: "w", sessionID: "s", startedAt: 1, env })
      baseline.apply({ type: "log", message: "v1" }, 2)
      await baseline.flush()
      const killer = new ProgressWriter({ runId: "wf_prog01", workflow: "w", sessionID: "s", startedAt: 1, env, inject: { failRename: true } })
      killer.apply({ type: "log", message: "v2" }, 3)
      await killer.flush()
      const snap = JSON.parse(await readFile(join(root, "opencode", "tool-output", "ultraopen", "wf_prog01", "progress.json"), "utf8"))
      expect(snap.logs).toEqual(["v1"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
