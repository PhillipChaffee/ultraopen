import { beforeEach, describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { Run } from "../src/server/runtime/run.js"
import type { ProgressEvent, RunOptions } from "../src/server/runtime/run.js"
import type { JournalEntry } from "../src/server/resume/journal.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { resolveOptions } from "../src/server/options.js"
import { CONTROL_STOP_ABORT_REASON, STOP_ABORT_REASON } from "../src/server/tool/background.js"
import { LARGE_RUN_AGENTS, LARGE_RUN_PROJECTED_TOKENS, MAX_AGENTS_PER_RUN, MAX_AGENT_RESTARTS } from "../src/server/script/limits.js"
import { chainKey } from "../src/server/resume/key.js"
import { createReloadableHost } from "../src/server/host/port.js"
import type { CreateChildSessionInput, HostPort, HostTurnResult } from "../src/server/host/port.js"

const git = promisify(execFile)

type CreateResult = { ok: true; sessionID: string } | { ok: false; detail: string }
type TurnResult = { ok: true; turn: HostTurnResult } | { ok: false; detail: string }
interface TurnInput {
  sessionID: string
  messageID: string
  text: string
}

const okTurn = (text: string, outputTokens = 0): TurnResult => ({
  ok: true,
  turn: { outcome: "succeeded", text, outputTokens },
})

const failedTurn = (outcome: HostTurnResult["outcome"], error?: { type: string; message: string }): TurnResult => ({
  ok: true,
  turn: { outcome, text: "", outputTokens: 0, ...(error === undefined ? {} : { error }) },
})

interface HostOptions {
  create?: (input: CreateChildSessionInput) => Promise<CreateResult>
  turn?: (input: TurnInput) => Promise<TurnResult>
  interrupt?: (sessionID: string) => Promise<boolean>
}

/** A hand-rolled fake HostPort; `create` auto-increments ids so multi-agent tests can tell them apart. */
function makeHost(options: HostOptions = {}) {
  const createCalls: CreateChildSessionInput[] = [],
   turnCalls: TurnInput[] = [],
   interrupted: string[] = []
  let nextSession = 0

  const host: HostPort = {
    location: { directory: "/work", canonical: "/canonical/work", projectID: "project-1" },
    defaultModel: () => Promise.resolve(undefined),
    listModels: () => Promise.resolve([]),
    getSession: () => Promise.resolve(undefined),
    getAgent: () => Promise.resolve(undefined),
    listAgents: () => Promise.resolve([]),
    listPendingPermissions: () => Promise.resolve([]),
    rejectPermission: () => Promise.resolve(),
    createChildSession: (input) => {
      createCalls.push(input)
      if (options.create) {return options.create(input)}
      nextSession++
      return Promise.resolve({ ok: true, sessionID: `child-${nextSession}` })
    },
    moveSession: () => Promise.resolve({ ok: true }),
    runTurn: (input) => {
      turnCalls.push(input)
      return options.turn ? options.turn(input) : Promise.resolve(okTurn("done"))
    },
    interruptSession: (sessionID) => {
      interrupted.push(sessionID)
      return options.interrupt ? options.interrupt(sessionID) : Promise.resolve(true)
    },
    admitSynthetic: () => Promise.resolve("admitted"),
  }
  return { host, createCalls, turnCalls, interrupted }
}

/** A project runtime for this test's own key, so semaphore tests never share state. */
function makeProject(
  coordinator: RuntimeCoordinator,
  concurrency = 8,
  projectID = "project-1",
): ProjectRuntime {
  return coordinator.projectOf(
    { directory: "/work", project: { id: projectID, canonical: `/canonical/${projectID}` } },
    { ...resolveOptions(undefined), concurrency },
  )
}

function makeRun(host: HostPort, overrides: Partial<RunOptions> = {}): Run {
  const coordinator = overrides.coordinator ?? getCoordinator(),
   project = overrides.project ?? makeProject(coordinator)
  return new Run({
    runId: "run-1",
    host,
    project,
    coordinator,
    parentSessionID: "parent-1",
    ancestorSessionIDs: [],
    ...overrides,
  })
}

/** A promise with its resolver, for gating fake async work from the test body. */
function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return [opened, release]
}

beforeEach(() => {
  resetCoordinatorForTests()
})

describe("Run — large-run advice", () => {
  test("fires once when the scheduled count crosses the threshold, and never again", async () => {
    const logs: string[] = [],
     { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 10)) }),
     run = makeRun(host, {
      onProgress: (event) => {
        if (event.type === "log") {logs.push(event.message)}
      },
     })
    for (let i = 0; i < LARGE_RUN_AGENTS + 2; i++) {
      await run.agent(`agent ${i}`)
    }
    const warnings = logs.filter((line) => line.includes("large-run warning"))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(`${LARGE_RUN_AGENTS} agents scheduled`)
  })

  test("fires from the token projection too, below the agent count", async () => {
    const logs: string[] = [],
     { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", LARGE_RUN_PROJECTED_TOKENS)) }),
     run = makeRun(host, {
      onProgress: (event) => {
        if (event.type === "log") {logs.push(event.message)}
      },
     })
    await run.agent("one expensive agent")
    expect(logs.filter((line) => line.includes("large-run warning")).length).toBe(1)
  })

  test("stays silent well below both thresholds, and isLargeRun reflects them", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 10)) }),
     run = makeRun(host)
    expect(run.isLargeRun).toBe(false)
    await run.agent("one")
    await run.agent("two")
    expect(run.logs.filter((line) => line.includes("large-run warning")).length).toBe(0)
    expect(run.isLargeRun).toBe(false)
  })
})

describe("Run — control commands", () => {
  test("pause holds THIS project's gate; resume releases it, and a sibling project is untouched", () => {
    const coordinator = getCoordinator(),
     project = makeProject(coordinator, 8, "project-a"),
     sibling = makeProject(coordinator, 8, "project-b"),
     logs: string[] = [],
     { host } = makeHost(),
     run = makeRun(host, {
      project,
      coordinator,
      onProgress: (event): void => {
        if (event.type === "log") {logs.push(event.message)}
      },
     })

    run.handleControl({ seq: 1, action: "pause" })
    expect(project.semaphore.paused).toBe(true)
    // The injected project's gate is the one used: another project never sees the pause.
    expect(sibling.semaphore.paused).toBe(false)
    expect(logs.join(" ")).toContain("run paused")

    run.handleControl({ seq: 2, action: "resume" })
    expect(project.semaphore.paused).toBe(false)
    expect(logs.join(" ")).toContain("run resumed")
  })

  test("stop-agent aborts exactly one agent and leaves its siblings untouched", async () => {
    const { host, interrupted } = makeHost({ turn: () => new Promise(() => {}) }),
     run = makeRun(host)
    const first = run.agent("first")
    const secondAgent = run.agent("second")
    await Bun.sleep(20)
    run.handleControl({ seq: 1, action: "stop-agent", target: 0 })
    await Bun.sleep(30)
    expect(interrupted).toEqual(["child-1"])
    run.handleControl({ seq: 2, action: "restart-agent", target: 0 })
    void first
    void secondAgent
  })

  test("the control surface exposes the actions the channel parses", () => {
    const run = makeRun(makeHost().host)
    expect(run.controlActions).toEqual(["pause", "resume", "stop-run", "stop-agent", "restart-agent"])
  })

  test("an unsupported or inapplicable control command logs, never crashes", () => {
    const logs: string[] = [],
     run = makeRun(makeHost().host, {
      onProgress: (event): void => {
        if (event.type === "log") {logs.push(event.message)}
      },
     })
    expect(() => run.handleControl({ seq: 1, action: "restart-agent", target: 99 })).not.toThrow()
    expect(logs.join(" ")).toContain("not implemented yet")
  })

  test("agent rows report their output tokens in the progress stream", async () => {
    const events: ProgressEvent[] = [],
     { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 4321)) }),
     run = makeRun(host, { onProgress: (event) => events.push(event) })
    await run.agent("do the thing")
    const end = events.find((event) => event.type === "agent-end") as { outputTokens?: number }
    expect(end?.outputTokens).toBe(4321)
  })
})

describe("Run.agent — happy path", () => {
  test("returns the turn's text when no schema", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("second", 5)) }),
     run = makeRun(host)
    expect(await run.agent("do the thing")).toBe("second")
  })

  test("returns the captured structured value (NOT text) when a schema is supplied", async () => {
    const coordinator = getCoordinator(),
     structured = { answer: 42 },
     { host } = makeHost({
      turn: ({ sessionID }) => {
        const record = coordinator.childOf(sessionID)
        if (record) {record.captured = { value: structured, attempt: record.currentAttempt }}
        return Promise.resolve(okTurn("ignored", 5))
      },
     }),
     run = makeRun(host),
     result = await run.agent("do the thing", { schema: { type: "object" } })
    expect(result).toBe(structured)
    expect(result).not.toBe("ignored")
  })

  test("records one entry with ok:true, the right index, and the turn's output tokens", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 17)) }),
     run = makeRun(host)
    await run.agent("do the thing")

    const record = run.records[0]
    if (!record) {throw new Error("expected a record")}
    expect(record.ok).toBe(true)
    expect(record.index).toBe(0)
    expect(record.outputTokens).toBe(17)
    expect(record.sessionID).toBe("child-1")
  })

  test("agentCount and index advance in call order", async () => {
    const run = makeRun(makeHost().host)
    expect(run.agentCount).toBe(0)
    await run.agent("first")
    await run.agent("second")
    expect(run.agentCount).toBe(2)
    expect(run.records.map((record) => record.index)).toEqual([0, 1])
  })

  test("children carry metadata.ultraopen with the run's ancestor chain", async () => {
    const { host, createCalls } = makeHost(),
     run = makeRun(host, { ancestorSessionIDs: ["root-session", "parent-parent"] })
    await run.agent("child work")
    expect(createCalls[0]?.metadata).toEqual({
      ultraopen: {
        runId: "run-1",
        bootId: getCoordinator().processBootId,
        parentSessionID: "parent-1",
        ancestorSessionIDs: ["root-session", "parent-parent"],
        label: "child work",
        index: 0,
      },
    })
    expect("parentID" in (createCalls[0] ?? {})).toBe(false)
  })
})

describe("Run.agent — failure", () => {
  test("a failing create resolves to null with spawn-failed and no sessionID", async () => {
    const { host } = makeHost({ create: () => Promise.resolve({ ok: false, detail: "boom" }) }),
     run = makeRun(host),
     result = await run.agent("do the thing")

    expect(result).toBeNull()
    const nullRecord = run.nulls[0]
    if (!nullRecord) {throw new Error("expected a null record")}
    expect(nullRecord.reason).toBe("spawn-failed")
    expect(nullRecord.detail).toBe("boom")
    expect(nullRecord.sessionID).toBeUndefined()
  })

  test("a transport failure after the session exists carries the sessionID", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve({ ok: false, detail: "server exploded" }) }),
     run = makeRun(host)
    await run.agent("do the thing")

    const nullRecord = run.nulls[0]
    if (!nullRecord) {throw new Error("expected a null record")}
    expect(nullRecord.reason).toBe("api-error")
    expect(nullRecord.sessionID).toBe("child-1")
  })

  test("run.outputTokens counts only successful agents", async () => {
    let createCount = 0
    const { host } = makeHost({
      create: () => {
        createCount++
        return createCount === 1 ? Promise.resolve({ ok: true, sessionID: "child-1" }) : Promise.resolve({ ok: false, detail: "boom" })
      },
      turn: () => Promise.resolve(okTurn("ok", 20)),
     }),
     run = makeRun(host)
    await run.agent("first")
    await run.agent("second")
    expect(run.outputTokens).toBe(20)
  })
})

describe("Run.agent — labels and phases", () => {
  test("an explicit label is used", async () => {
    const run = makeRun(makeHost().host)
    await run.agent("do the thing", { label: "custom-label" })
    expect(run.records[0]?.label).toBe("custom-label")
  })

  test("no label derives one from the prompt's first line, truncated to 48 characters", async () => {
    const run = makeRun(makeHost().host),
     longLine = "y".repeat(80)
    await run.agent(`${longLine}\nsecond line is ignored`)
    expect(run.records[0]?.label).toBe(longLine.slice(0, 48))
  })

  test("phase() sets currentPhase, and an explicit opts.phase overrides it for one agent", async () => {
    const run = makeRun(makeHost().host)
    run.phase("discovery")
    expect(run.currentPhase).toBe("discovery")
    await run.agent("first", { phase: "override" })
    await run.agent("second")
    expect(run.records[0]?.phase).toBe("override")
    expect(run.records[1]?.phase).toBe("discovery")
  })
})

describe("Run.agent — validation and caps", () => {
  test("a non-string, empty, or whitespace-only prompt throws a TypeError", async () => {
    const { host, createCalls } = makeHost(),
     run = makeRun(host)
    await expect(run.agent(42 as unknown as string)).rejects.toThrow(TypeError)
    await expect(run.agent("")).rejects.toThrow(TypeError)
    await expect(run.agent("   \n\t  ")).rejects.toThrow(TypeError)
    expect(createCalls).toHaveLength(0)
  })

  test("a provably contradictory schema rejects at call time before any session is created", async () => {
    const { host, createCalls, turnCalls } = makeHost(),
     run = makeRun(host)
    await expect(
      run.agent("work", { schema: { type: "object", additionalProperties: false, required: ["id"], properties: {} } }),
    ).rejects.toThrow(/"id"/u)
    await expect(run.agent("work", { schema: { type: "number", minimum: 10, maximum: 5 } })).rejects.toThrow(
      /minimum 10 is above maximum 5/u,
    )
    expect(createCalls).toHaveLength(0)
    expect(turnCalls).toHaveLength(0)
    expect(run.agentCount).toBe(0)
  })

  test("a satisfiable schema whose output misses still ladders through Run.agent in ONE session", async () => {
    const { host, turnCalls } = makeHost({ turn: () => Promise.resolve(okTurn("prose")) }),
     run = makeRun(host),
     value = await run.agent("work", { schema: { type: "object" } })

    expect(value).toBeNull()
    expect(turnCalls).toHaveLength(3)
    // The ladder retries in the SAME session — a fresh session per attempt would lose research.
    expect(new Set(turnCalls.map((call) => call.sessionID)).size).toBe(1)
  })

  test("the lifetime cap rejects the call past MAX_AGENTS_PER_RUN without inflating agentCount", async () => {
    const coordinator = getCoordinator(),
     project = makeProject(coordinator, 32, "cap-project"),
     { host } = makeHost({ create: () => Promise.resolve({ ok: false, detail: "cap-test" }) }),
     run = makeRun(host, { project, coordinator }),
     promises: Promise<unknown>[] = []
    for (let i = 0; i < MAX_AGENTS_PER_RUN; i++) {
      promises.push(run.agent(`prompt ${i}`))
    }
    expect(run.agentCount).toBe(MAX_AGENTS_PER_RUN)

    const overflow = run.agent("prompt over the cap")
    await expect(overflow).rejects.toThrow(String(MAX_AGENTS_PER_RUN))
    expect(run.agentCount).toBe(MAX_AGENTS_PER_RUN)
    await Promise.all(promises)
  })
})

describe("Run.agent — concurrency", () => {
  test("the injected project's semaphore is respected: at most its limit runs at once", async () => {
    const coordinator = getCoordinator(),
     project = makeProject(coordinator, 2, "concurrency-project")
    let inFlight = 0,
     peak = 0
    const { host } = makeHost({
      turn: () =>
        new Promise((resolve) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          setTimeout(() => {
            inFlight--
            resolve(okTurn("done"))
          }, 0)
        }),
     }),
     run = makeRun(host, { project, coordinator })

    await Promise.all(Array.from({ length: 6 }, (_unused, i) => run.agent(`prompt ${i}`)))

    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1)
    expect(inFlight).toBe(0)
  })

  test("the permit is released even when spawn fails, so failing agents never deadlock", async () => {
    const coordinator = getCoordinator(),
     project = makeProject(coordinator, 2, "failure-project"),
     { host } = makeHost({ create: () => Promise.resolve({ ok: false, detail: "boom" }) }),
     run = makeRun(host, { project, coordinator }),
     results = await Promise.all(Array.from({ length: 6 }, (_unused, i) => run.agent(`prompt ${i}`)))

    expect(results.every((result) => result === null)).toBe(true)
    expect(run.nulls.length).toBe(6)
  })
})

describe("Run.agent — budget", () => {
  test("a call past the ceiling throws instead of silently spending", async () => {
    const run = makeRun(makeHost().host, { budgetTotal: 100 })
    await run.agent("burn tokens", { label: "spend" })
    const first = run.records[0]
    if (!first) {throw new Error("expected a record")}
    first.outputTokens = 500
    await expect(run.agent("one more")).rejects.toThrow(/100 output-token budget/u)
  })

  test("a nested child charges the parent's ledger, and the parent's remaining() moves", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 60)) }),
     parent = makeRun(host, { budgetTotal: 1000 }),
     child = makeRun(host, { budgetTotal: 1000, familySpend: parent.familySpend })

    await child.agent("child work")
    expect(child.budget.spent()).toBe(60)
    expect(parent.budget.spent()).toBe(60)
    expect(parent.budget.remaining()).toBe(940)

    await parent.agent("parent work")
    expect(parent.budget.spent()).toBe(120)
    expect(child.budget.spent()).toBe(120)
  })

  test("the family ceiling binds each child to the whole family's spend, not its own", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 600)) }),
     parent = makeRun(host, { budgetTotal: 600 }),
     child = makeRun(host, { budgetTotal: 600, familySpend: parent.familySpend })

    await parent.agent("parent burns")
    await expect(child.agent("child work")).rejects.toThrow(/600 output-token budget/u)
    await expect(parent.agent("parent again")).rejects.toThrow(/600 output-token budget/u)
  })

  test("a top-level run owns its family, so sibling runs never see each other's spend", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 60)) }),
     a = makeRun(host, { budgetTotal: 1000 }),
     b = makeRun(host, { budgetTotal: 1000 })

    await a.agent("a work")
    expect(a.budget.spent()).toBe(60)
    expect(b.budget.spent()).toBe(0)
  })

  test("replayed entries count as paid, so a resumed family's ceiling accounts for them", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn("hi", 600)) })
    const firstParent = makeRun(host, { budgetTotal: 1000 }),
     firstChild = makeRun(host, { budgetTotal: 1000, familySpend: firstParent.familySpend })
    await firstParent.agent("parent work")
    await firstChild.agent("child work")
    expect(firstParent.budget.spent()).toBe(1200)

    const previous = [...firstParent.journal.entries, ...firstChild.journal.entries],
     parent = makeRun(host, { budgetTotal: 1000, previousEntries: previous, resumedFrom: "wf_prev0000" }),
     child = makeRun(host, {
      budgetTotal: 1000,
      previousEntries: previous,
      resumedFrom: "wf_prev0000",
      familySpend: parent.familySpend,
     })
    await parent.agent("parent work")
    await child.agent("child work")
    expect(parent.records[0]?.replayed).toBe(true)
    expect(parent.budget.spent()).toBe(1200)
    await expect(parent.agent("one more")).rejects.toThrow(/1000 output-token budget/u)
  })
})

describe("Run.agent — abort", () => {
  test("a stop-request abort stamps its reason into the null journal entry", async () => {
    const controller = new AbortController(),
     { host } = makeHost({
      turn: () => {
        controller.abort(STOP_ABORT_REASON)
        return Promise.resolve(failedTurn("interrupted"))
      },
     }),
     run = makeRun(host, { signal: controller.signal })

    await expect(run.agent("first")).resolves.toBeNull()
    const stopped = run.journal.entries.at(-1)
    expect(stopped?.status).toBe("null")
    expect(stopped?.reason).toBe("aborted")
    expect(stopped?.detail).toBe(STOP_ABORT_REASON)
  })

  test("the control channel's abort reason stamps its provenance into the null journal entry", async () => {
    const controller = new AbortController(),
     { host } = makeHost({
      turn: () => {
        controller.abort(CONTROL_STOP_ABORT_REASON)
        return Promise.resolve(failedTurn("interrupted"))
      },
     }),
     run = makeRun(host, { signal: controller.signal })

    await expect(run.agent("first")).resolves.toBeNull()
    expect(run.journal.entries.at(-1)?.detail).toBe(CONTROL_STOP_ABORT_REASON)
  })

  test("an already-aborted run throws BEFORE creating a session or worktree", async () => {
    const { host, createCalls } = makeHost(),
     controller = new AbortController()
    controller.abort()
    const run = makeRun(host, { signal: controller.signal })

    await expect(run.agent("do the thing")).rejects.toThrow(/aborted/u)
    expect(createCalls).toEqual([])
  })

  test("an abort while queued for a permit rejects instead of spawning later", async () => {
    const coordinator = getCoordinator(),
     project = makeProject(coordinator, 1, "queued-project"),
     [firstPromptGate, releaseFirst] = gate(),
     [started, markStarted] = gate(),
     { host, createCalls } = makeHost({
      turn: (call) => {
        markStarted()
        if (call.sessionID === "child-1") {
          return firstPromptGate.then(() => okTurn("done"))
        }
        return Promise.resolve(okTurn("done"))
      },
     }),
     controller = new AbortController(),
     run = makeRun(host, { project, coordinator, signal: controller.signal }),
     first = run.agent("first")
    await started
    const queued = run.agent("second")
    controller.abort()
    releaseFirst()

    await expect(queued).rejects.toThrow(/concurrency permit/u)
    expect(createCalls.length).toBe(1)
    // The parent's abort reaches the in-flight agent too: V2 aborts the turn, it does not let it
    // finish. The queued agent never reached a session.
    await expect(first).resolves.toBeNull()
  })
})

describe("Run.agent — deadline propagation", () => {
  test("a hung agent is abandoned once deadlineMs passes and surfaces as deadline", async () => {
    const { host } = makeHost({ turn: () => new Promise(() => {}) }),
     run = makeRun(host, { deadlineMs: 10, idleMs: 0 }),
     result = await run.agent("hung")
    expect(result).toBeNull()
    expect(run.nulls[0]?.reason).toBe("deadline")
  })

  test("an agent with no progress is killed by the idle limit even with the wall clock disabled", async () => {
    const { host } = makeHost({ turn: () => new Promise(() => {}) }),
     run = makeRun(host, { deadlineMs: 0, idleMs: 20 }),
     result = await run.agent("stalled")
    expect(result).toBeNull()
    expect(run.nulls[0]?.reason).toBe("idle-deadline")
    expect(run.nulls[0]?.detail).toMatch(/made no progress/u)
  })
})

describe("Run.agent — stall auto-restart (idle kills only)", () => {
  test("an idle-deadline null is restarted and a later attempt succeeds", async () => {
    let calls = 0
    const { host } = makeHost({
      turn: () => {
        calls++
        return calls === 1 ? new Promise(() => {}) : Promise.resolve(okTurn("recovered", 5))
      },
     }),
     journal: JournalEntry[] = [],
     run = makeRun(host, { deadlineMs: 0, idleMs: 10, onJournal: (entry) => journal.push(entry) }),
     result = await run.agent("flaky stall")

    expect(result).toBe("recovered")
    expect(run.nulls.length).toBe(0)
    expect(journal.length).toBe(2)
    expect(journal[0]?.status).toBe("null")
    expect(journal[0]?.attempt).toBe(1)
    expect(journal[1]?.status).toBe("ok")
    expect(journal[1]?.attempt).toBe(2)
    expect(journal[0]?.key).toBe(journal[1]?.key)
  })

  test("restarts stop at MAX_AGENT_RESTARTS and the final null is reported once", async () => {
    const { host, turnCalls } = makeHost({ turn: () => new Promise(() => {}) }),
     journal: JournalEntry[] = [],
     run = makeRun(host, { deadlineMs: 0, idleMs: 10, onJournal: (entry) => journal.push(entry) }),
     result = await run.agent("always stalls")

    expect(result).toBeNull()
    expect(turnCalls.length).toBe(1 + MAX_AGENT_RESTARTS)
    expect(journal.length).toBe(1 + MAX_AGENT_RESTARTS)
    expect(new Set(journal.map((entry) => entry.key)).size).toBe(1)
    expect(journal.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4])
    expect(run.nulls.length).toBe(1)
    expect(run.nulls[0]?.reason).toBe("idle-deadline")
  })

  test("an api-error null is NOT restarted", async () => {
    const { host, turnCalls } = makeHost({
      turn: () => Promise.resolve(failedTurn("failed", { type: "APIError", message: "transport" })),
     }),
     journal: JournalEntry[] = [],
     run = makeRun(host, { deadlineMs: 0, idleMs: 10, onJournal: (entry) => journal.push(entry) }),
     result = await run.agent("transport error")

    expect(result).toBeNull()
    expect(turnCalls.length).toBe(1)
    expect(journal.length).toBe(1)
    expect(journal[0]?.reason).toBe("api-error")
  })

  test("a wall-clock kill is NEVER restarted", async () => {
    const { host, turnCalls } = makeHost({ turn: () => new Promise(() => {}) }),
     run = makeRun(host, { deadlineMs: 10, idleMs: 0 }),
     result = await run.agent("pathologically productive")

    expect(result).toBeNull()
    expect(turnCalls.length).toBe(1)
    expect(run.nulls[0]?.reason).toBe("deadline")
  })

  test("a parent abort is never restarted", async () => {
    const { host, turnCalls } = makeHost({ turn: () => new Promise(() => {}) }),
     run = makeRun(host, { deadlineMs: 10, idleMs: 0, signal: AbortSignal.timeout(5) }),
     result = await run.agent("parent aborted")

    expect(result).toBeNull()
    expect(turnCalls.length).toBeLessThanOrEqual(1)
  })

  test("the newest ok entry wins replay after a restart", async () => {
    const key = chainKey("root", "restarted", {}),
     okEntry: JournalEntry = {
      type: "result",
      key,
      scopePath: "root",
      ordinal: 0,
      label: "restarted",
      status: "ok",
      value: "recovered",
      outputTokens: 5,
      attempt: 2,
     },
     nullEntry: JournalEntry = {
      type: "result",
      key,
      scopePath: "root",
      ordinal: 0,
      label: "restarted",
      status: "null",
      reason: "deadline",
      detail: "abandoned",
      outputTokens: 0,
      attempt: 1,
     },
     journal: JournalEntry[] = [],
     run = makeRun(makeHost().host, { onJournal: (entry) => journal.push(entry), previousEntries: [nullEntry, okEntry] }),
     result = await run.agent("restarted")

    expect(result).toBe("recovered")
    expect(run.records[0]?.replayed).toBe(true)
    expect(journal.length).toBe(1)
    expect(journal[0]?.replayed).toBe(true)
  })
})

describe("Run.agent — worktree isolation", () => {
  test("the child is routed to its worktree, and abortAll interrupts BEFORE releasing it", async () => {
    const repo = await mkdtemp(join(tmpdir(), "ultraopen-run-wt-"))
    await git("git", ["-C", repo, "init", "-q"])
    await git("git", ["-C", repo, "config", "user.email", "t@example.com"])
    await git("git", ["-C", repo, "config", "user.name", "t"])
    await writeFile(join(repo, "file.txt"), "hello\n")
    await git("git", ["-C", repo, "add", "."])
    await git("git", ["-C", repo, "commit", "-qm", "init"])

    const directories = new Map<string, string>()
    let sawDirectoryDuringInterrupt = false
    const coordinator = getCoordinator(),
     project = makeProject(coordinator),
     { host, createCalls } = makeHost({
      interrupt: (sessionID) => {
        const directory = directories.get(sessionID)
        sawDirectoryDuringInterrupt = directory !== undefined && existsSync(directory)
        return Promise.resolve(true)
      },
     }),
     wrapped: HostPort = {
      ...host,
      createChildSession: (input) => {
        const created = host.createChildSession(input)
        if (input.location !== undefined) {
          void created.then((result) => (result.ok ? directories.set(result.sessionID, input.location ?? "") : undefined))
        }
        return created
      },
     },
     run = makeRun(wrapped, { worktreeRoot: repo, coordinator, project })

    try {
      await run.agent("work in isolation", { isolation: "worktree", label: "iso" })
      const directory = createCalls[0]?.location
      expect(directory).toBeTruthy()
      if (directory === undefined) {throw new Error("expected a worktree location")}
      expect(existsSync(directory)).toBe(true)
      // The worktree creation was serialized through THIS project's queue.
      expect(project.worktreeQueues.size).toBe(1)

      await run.abortAll()
      // ORDER: the child was interrupted while its working directory still existed.
      expect(sawDirectoryDuringInterrupt).toBe(true)
      expect(existsSync(directory)).toBe(false)
    } finally {
      await git("git", ["-C", repo, "worktree", "prune"]).catch(() => undefined)
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("progress", () => {
  test("onProgress fires agent-start before agent-end, plus phase and log events", async () => {
    const events: ProgressEvent[] = [],
     run = makeRun(makeHost().host, { onProgress: (event) => events.push(event) })

    run.phase("discovery")
    run.log("starting up")
    await run.agent("do the thing")

    const startIndex = events.findIndex((event) => event.type === "agent-start"),
     endIndex = events.findIndex((event) => event.type === "agent-end")
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBeGreaterThan(startIndex)
    expect(events.some((event) => event.type === "phase" && event.title === "discovery")).toBe(true)
    expect(events.some((event) => event.type === "log" && event.message === "starting up")).toBe(true)
  })

  test("onJournal fires once per agent, at record time", async () => {
    const entries: JournalEntry[] = [],
     run = makeRun(makeHost().host, { onJournal: (entry) => entries.push(entry) })

    await run.agent("first")
    await run.agent("second")

    expect(entries.length).toBe(2)
    expect(entries[0]?.status).toBe("ok")
    expect(run.journal.entries).toEqual(entries)
  })

  test("log() appends to run.logs", () => {
    const run = makeRun(makeHost().host)
    run.log("hello")
    run.log("world")
    expect(run.logs).toEqual(["hello", "world"])
  })
})

describe("abortAll", () => {
  test("interrupts every child session and forgets them from the coordinator", async () => {
    const coordinator = getCoordinator(),
     { host, interrupted } = makeHost(),
     run = makeRun(host, { coordinator })
    await run.agent("first")
    await run.agent("second")
    expect(coordinator.sessionsOf("run-1").length).toBe(2)

    await run.abortAll()

    expect(interrupted.toSorted()).toEqual(["child-1", "child-2"])
    expect(coordinator.sessionsOf("run-1")).toEqual([])
  })

  test("an interrupt that rejects does not make abortAll() reject", async () => {
    const coordinator = getCoordinator(),
     { host } = makeHost({ interrupt: () => Promise.reject(new Error("remote interrupt is down")) }),
     run = makeRun(host, { coordinator })
    await run.agent("first")

    await expect(run.abortAll()).resolves.toBeUndefined()
    expect(coordinator.sessionsOf("run-1")).toEqual([])
  })
})

describe("option plumbing and the reload seam", () => {
  test("resolveModel/resolveVariant/subagentContract reach the child's creation and record", async () => {
    const { host, createCalls } = makeHost(),
     run = makeRun(host, {
      resolveModel: () => ({ providerID: "anthropic", modelID: "claude-x" }),
      resolveVariant: () => "high",
      subagentContract: () => "extra contract text",
     })
    await run.agent("do the thing", { model: "anthropic/claude-x", effort: "high" })

    expect(createCalls[0]?.model).toEqual({ providerID: "anthropic", modelID: "claude-x", variant: "high" })
    expect(getCoordinator().childOf("child-1")?.contractText).toBe("extra contract text")
  })

  test("undefined resolvers leave the corresponding fields absent", async () => {
    const { host, createCalls } = makeHost(),
     run = makeRun(host, {
      resolveModel: () => undefined,
      resolveVariant: () => undefined,
      subagentContract: () => undefined,
     })
    await run.agent("do the thing")

    expect("model" in (createCalls[0] ?? {})).toBe(false)
    expect(getCoordinator().childOf("child-1")?.contractText).toBeUndefined()
  })

  test("a reloadable host proxy reaches in-flight runs at the next call, with no record mutation", async () => {
    const first = makeHost(),
     second = makeHost(),
     coordinator = getCoordinator()
    let active: HostPort = first.host
    const run = makeRun(createReloadableHost(() => active), { coordinator })

    await run.agent("before reload")
    active = second.host
    await run.agent("after reload")

    expect(first.createCalls.length).toBe(1)
    expect(second.createCalls.length).toBe(1)
  })
})

describe("Run.agent — defensive token extraction", () => {
  test("a non-finite token count degrades to 0 rather than crashing the run", async () => {
    const { host } = makeHost({
      turn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "fine", outputTokens: Number.NaN } }),
     }),
     run = makeRun(host)

    expect(await run.agent("x")).toBe("fine")
    expect(run.outputTokens).toBe(0)
    expect(run.nulls.length).toBe(0)
  })

  test("a non-numeric token count is ignored", async () => {
    const { host } = makeHost({
      turn: () =>
        Promise.resolve({
          ok: true,
          turn: { outcome: "succeeded", text: "fine", outputTokens: "lots" as unknown as number },
        }),
     }),
     run = makeRun(host)
    await run.agent("x")
    expect(run.outputTokens).toBe(0)
  })
})
