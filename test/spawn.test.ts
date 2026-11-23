import { beforeEach, describe, expect, test } from "bun:test"
import { mintMessageID, spawn, tokensOf } from "../src/server/bridge/spawn.js"
import type { SpawnOptions } from "../src/server/bridge/spawn.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { CreateChildSessionInput, HostPort, HostTurnResult } from "../src/server/host/port.js"

const SCHEMA = { type: "object", required: ["answer"], properties: { answer: { type: "string" } } }

type CreateResult = { ok: true; sessionID: string } | { ok: false; detail: string }
type MoveResult = { ok: true } | { ok: false; detail: string }
type TurnResult = { ok: true; turn: HostTurnResult } | { ok: false; detail: string }

const okTurn = (text: string, outputTokens = 5): TurnResult => ({
  ok: true,
  turn: { outcome: "succeeded", text, outputTokens },
})

const failedTurn = (outcome: HostTurnResult["outcome"], error?: { type: string; message: string }): TurnResult => ({
  ok: true,
  turn: { outcome, text: "", outputTokens: 3, ...(error === undefined ? {} : { error }) },
})

/** A promise with its resolver, for gating fake async work from the test body. */
function gate(): [Promise<void>, () => void] {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return [opened, release]
}

interface HostOptions {
  create?: (input: CreateChildSessionInput) => Promise<CreateResult>
  move?: (sessionID: string, directory: string) => Promise<MoveResult>
  turn?: (input: { sessionID: string; messageID: string; text: string }) => Promise<TurnResult>
  interrupt?: (sessionID: string) => Promise<boolean>
}

/**
 * A hand-rolled fake {@link HostPort} — no mocking library. It records every call so tests assert
 * on exactly what the bridge sent, and lets each test swap in custom behavior.
 */
function makeHost(settings: HostOptions = {}) {
  const createCalls: CreateChildSessionInput[] = [],
   moveCalls: { sessionID: string; directory: string }[] = [],
   turnCalls: { sessionID: string; messageID: string; text: string }[] = [],
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
      if (settings.create) {return settings.create(input)}
      nextSession++
      return Promise.resolve({ ok: true, sessionID: `child-${nextSession}` })
    },
    moveSession: (sessionID, directory) => {
      moveCalls.push({ sessionID, directory })
      return settings.move ? settings.move(sessionID, directory) : Promise.resolve({ ok: true })
    },
    runTurn: (input) => {
      turnCalls.push(input)
      return settings.turn ? settings.turn(input) : Promise.resolve(okTurn("done"))
    },
    interruptSession: (sessionID) => {
      interrupted.push(sessionID)
      return settings.interrupt ? settings.interrupt(sessionID) : Promise.resolve(true)
    },
    admitSynthetic: () => Promise.resolve("admitted"),
  }
  return { host, createCalls, moveCalls, turnCalls, interrupted }
}

function options(overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    prompt: "do the thing",
    runId: "run-1",
    parentSessionID: "parent-1",
    ancestorSessionIDs: ["root-session"],
    projectKey: "project-key",
    coordinator: getCoordinator(),
    label: "worker",
    ...overrides,
  }
}

// The coordinator is process-wide by design, so every test starts from a clean slate.
beforeEach(() => {
  resetCoordinatorForTests()
})

describe("spawn — V2 child creation", () => {
  test("passes metadata.ultraopen with full lineage and NEVER passes parentID", async () => {
    const { host, createCalls, turnCalls } = makeHost(),
     result = await spawn(
      host,
      options({
        agentType: "reviewer",
        agentIndex: 2,
        model: { providerID: "anthropic", modelID: "claude" },
        variant: "high",
        system: "contract text",
      }),
    )

    expect(result.ok).toBe(true)
    const create = createCalls[0]
    if (create === undefined) {throw new Error("expected a create call")}
    // THE V2 INVARIANT: a `parentID` makes the host steer the parent on every child turn and
    // discards the child's location. Lineage lives in metadata instead.
    expect("parentID" in create).toBe(false)
    expect(create.title).toBe("ultraopen · worker")
    expect(create.agent).toBe("reviewer")
    expect(create.model).toEqual({ providerID: "anthropic", modelID: "claude", variant: "high" })
    expect(create.metadata).toEqual({
      ultraopen: {
        runId: "run-1",
        bootId: getCoordinator().processBootId,
        parentSessionID: "parent-1",
        ancestorSessionIDs: ["root-session"],
        label: "worker",
        index: 2,
      },
    })
    expect(Array.isArray(create.permissions)).toBe(true)
    expect(create.permissions?.some((rule) => rule.action === "workflow" && rule.effect === "deny")).toBe(true)

    const turn = turnCalls[0]
    if (turn === undefined) {throw new Error("expected a turn call")}
    expect(turn.messageID.startsWith("msg_")).toBe(true)
    expect(turn.text).toBe("do the thing")
    if (!result.ok) {throw new Error("expected success")}
    expect(result.text).toBe("done")
    expect(result.outputTokens).toBe(5)
  })

  test("registers the child and announces it only after registration", async () => {
    const coordinator = getCoordinator(),
     announced: string[] = []
    const { host } = makeHost()
    const result = await spawn(
      host,
      options({
        onChildCreated: (sessionID) => {
          // By announcement time the coordinator must already own the child.
          expect(coordinator.owns(sessionID)).toBe(true)
          announced.push(sessionID)
        },
      }),
    )
    if (!result.ok) {throw new Error("expected success")}
    expect(announced).toEqual([result.sessionID])
    expect(coordinator.childOf(result.sessionID)?.label).toBe("worker")
    expect(coordinator.childOf(result.sessionID)?.currentAttempt).toBe(0)
  })

  test("a non-object root schema records wrapped: true; an object root does not", async () => {
    const coordinator = getCoordinator(),
     { host } = makeHost({
      turn: ({ sessionID }) => {
        const record = coordinator.childOf(sessionID)
        if (record) {record.captured = { value: { value: 42 }, attempt: record.currentAttempt }}
        return Promise.resolve(okTurn("prose"))
      },
     })

    const wrapped = await spawn(host, options({ schema: { type: "number" } }))
    const wrappedID = wrapped.ok ? wrapped.sessionID : ""
    expect(coordinator.childOf(wrappedID)?.wrapped).toBe(true)
    // The envelope is a transport detail the script must never see.
    if (wrapped.ok) {expect(wrapped.structured).toBe(42)}

    const plain = await spawn(host, options({ schema: SCHEMA }))
    const plainID = plain.ok ? plain.sessionID : ""
    expect(coordinator.childOf(plainID)?.wrapped).toBe(false)
  })

  test("omitted options are absent from the create input", async () => {
    const { host, createCalls, moveCalls } = makeHost()
    await spawn(host, options())
    const create = createCalls[0]
    if (create === undefined) {throw new Error("expected a create call")}
    expect("agent" in create).toBe(false)
    expect("model" in create).toBe(false)
    expect("location" in create).toBe(false)
    expect(moveCalls).toEqual([])
  })

  test("a model that already carries a variant keeps it", async () => {
    const { host, createCalls } = makeHost()
    await spawn(host, options({ model: { providerID: "a", modelID: "b", variant: "max" }, variant: "low" }))
    expect(createCalls[0]?.model).toEqual({ providerID: "a", modelID: "b", variant: "max" })
  })
})

describe("spawn — worktree location", () => {
  test("a directory is passed AND verified via moveSession", async () => {
    const { host, createCalls, moveCalls } = makeHost()
    const result = await spawn(host, options({ directory: "/worktrees/agent" }))
    expect(result.ok).toBe(true)
    expect(createCalls[0]?.location).toBe("/worktrees/agent")
    expect(moveCalls).toEqual([{ sessionID: "child-1", directory: "/worktrees/agent" }])
  })

  test("a worktree child denies edits to the canonical checkout", async () => {
    const { host, createCalls } = makeHost()
    await spawn(host, options({ directory: "/worktrees/agent" }))
    const permissions = createCalls[0]?.permissions ?? []
    expect(permissions).toContainEqual({ action: "edit", resource: "/canonical/work/**", effect: "deny" })
  })

  test("a child that is not isolated has no canonical-checkout edit deny", async () => {
    const { host, createCalls } = makeHost()
    await spawn(host, options())
    const permissions = createCalls[0]?.permissions ?? []
    expect(permissions).not.toContainEqual({ action: "edit", resource: "/canonical/work/**", effect: "deny" })
  })

  test("a child placed back in the canonical checkout is not treated as worktree-isolated", async () => {
    const { host, createCalls } = makeHost()
    await spawn(host, options({ directory: "/canonical/work" }))
    const permissions = createCalls[0]?.permissions ?? []
    expect(permissions).not.toContainEqual({ action: "edit", resource: "/canonical/work/**", effect: "deny" })
  })

  test("a failed move fails CLOSED with api-error, interrupts the child, and registers nothing", async () => {
    const coordinator = getCoordinator(),
     { host, interrupted } = makeHost({
      move: () => Promise.resolve({ ok: false, detail: "session is in /canonical, expected /worktrees/agent" }),
     })
    const announced: string[] = [],
     result = await spawn(
      host,
      options({ directory: "/worktrees/agent", onChildCreated: (id) => announced.push(id) }),
     )

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("api-error")
    expect(result.detail).toContain("expected /worktrees/agent")
    // Fail closed: the child that landed in the wrong place must not keep running.
    expect(interrupted).toEqual(["child-1"])
    expect(coordinator.owns("child-1")).toBe(false)
    expect(announced).toEqual([])
  })
})

describe("spawn — creation failures", () => {
  test("a failed create reports spawn-failed with the host's detail", async () => {
    const coordinator = getCoordinator(),
     { host, turnCalls } = makeHost({ create: () => Promise.resolve({ ok: false, detail: "bad agent name" }) }),
     result = await spawn(host, options())

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("spawn-failed")
    expect(result.detail).toBe("bad agent name")
    expect(turnCalls).toEqual([])
    expect(coordinator.owns("child-1")).toBe(false)
  })
})

describe("spawn — structured capture", () => {
  test("schema mode returns the captured value for the CURRENT attempt", async () => {
    const coordinator = getCoordinator(),
     { host } = makeHost({
      turn: ({ sessionID }) => {
        const record = coordinator.childOf(sessionID)
        if (record) {record.captured = { value: { answer: "yes" }, attempt: record.currentAttempt }}
        return Promise.resolve(okTurn("prose noise", 7))
      },
     }),
     result = await spawn(host, options({ schema: SCHEMA }))

    if (!result.ok) {throw new Error("expected success")}
    expect(result.structured).toEqual({ answer: "yes" })
    expect(result.text).toBe("prose noise")
    expect(result.outputTokens).toBe(7)
  })

  test("prose JSON without a StructuredOutput capture is NEVER parsed — it is schema-failed", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve(okTurn('{"answer":"yes"}')) }),
     result = await spawn(host, options({ schema: SCHEMA }))

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("schema-failed")
    expect(result.detail).toBe("no structured output was produced")
  })

  test("a capture from a DIFFERENT attempt does not satisfy the current one", async () => {
    const coordinator = getCoordinator(),
     { host } = makeHost({
      turn: ({ sessionID }) => {
        const record = coordinator.childOf(sessionID)
        if (record) {record.captured = { value: { answer: "stale" }, attempt: record.currentAttempt + 1 }}
        return Promise.resolve(okTurn("prose"))
      },
     }),
     result = await spawn(host, options({ schema: SCHEMA }))

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("schema-failed")
  })

  test("a wrapped schema whose capture is not enveloped still validates", async () => {
    const coordinator = getCoordinator(),
     { host } = makeHost({
      turn: ({ sessionID }) => {
        const record = coordinator.childOf(sessionID)
        if (record) {record.captured = { value: 42, attempt: record.currentAttempt }}
        return Promise.resolve(okTurn(""))
      },
     }),
     result = await spawn(host, options({ schema: { type: "number" } }))

    if (!result.ok) {throw new Error("expected success")}
    expect(result.structured).toBe(42)
  })
})

describe("spawn — host turn outcomes", () => {
  test.each([
    ["interrupted outcome", failedTurn("interrupted"), "aborted"],
    ["an abort error", failedTurn("failed", { type: "MessageAbortedError", message: "stopped" }), "aborted"],
    [
      "a context overflow",
      failedTurn("failed", { type: "ContextOverflowError", message: "too long" }),
      "context-overflow",
    ],
    ["any other API error", failedTurn("failed", { type: "APIError", message: "rate limited" }), "api-error"],
    ["a failed turn with no error", failedTurn("failed"), "api-error"],
  ] as const)("%s maps to %s", async (_label, turn, expected) => {
    const { host } = makeHost({ turn: () => Promise.resolve(turn) }),
     result = await spawn(host, options())
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe(expected)
  })

  test("a transport failure is api-error with the host's detail", async () => {
    const { host } = makeHost({ turn: () => Promise.resolve({ ok: false, detail: "server exploded" }) }),
     result = await spawn(host, options())
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("api-error")
    expect(result.detail).toBe("server exploded")
  })

  test("a rejecting runTurn is api-error with the thrown message", async () => {
    const { host } = makeHost({ turn: () => Promise.reject(new Error("network down")) }),
     result = await spawn(host, options())
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("api-error")
    expect(result.detail).toBe("network down")
  })

  test("an error-shaped object with a name but no message falls back to that name", async () => {
    const { host } = makeHost({
      // eslint-disable-next-line prefer-promise-reject-errors -- a drifted transport can throw a non-Error
      turn: () => Promise.reject({ name: "WeirdError" }),
     }),
     result = await spawn(host, options())
    if (result.ok) {throw new Error("expected failure")}
    expect(result.detail).toBe("WeirdError")
  })

  test("a thrown value with no recognizable shape falls back to JSON", async () => {
    const { host } = makeHost({
      // eslint-disable-next-line prefer-promise-reject-errors -- a drifted transport can throw a non-Error
      turn: () => Promise.reject(42),
     }),
     result = await spawn(host, options())
    if (result.ok) {throw new Error("expected failure")}
    expect(result.detail).toBe("42")
  })

  test("a non-finite token count degrades to 0 rather than poisoning the budget", async () => {
    const { host } = makeHost({
      turn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "fine", outputTokens: Number.NaN } }),
     }),
     result = await spawn(host, options())
    if (!result.ok) {throw new Error("expected success")}
    expect(result.outputTokens).toBe(0)
  })
})

describe("spawn — a rejecting interrupt is swallowed", () => {
  test("a failed cleanup interrupt still surfaces the move failure", async () => {
    const { host } = makeHost({
      move: () => Promise.resolve({ ok: false, detail: "cannot move" }),
      interrupt: () => Promise.reject(new Error("interrupt down")),
    })
    const result = await spawn(host, options({ directory: "/worktree" }))
    expect(result.ok).toBe(false)
    if (!result.ok) {expect(result.detail).toBe("cannot move")}
  })

  test("an abort during the turn whose interrupt rejects still reports aborted", async () => {
    const controller = new AbortController(),
     [started, markStarted] = gate(),
     { host, interrupted } = makeHost({
      turn: () => {
        markStarted()
        return new Promise(() => {})
      },
      interrupt: () => Promise.reject(new Error("interrupt down")),
     }),
     pending = spawn(host, options({ signal: controller.signal }))

    // Attach the abort only after the turn is in flight, or promptChild short-circuits at entry
    // and the rejecting interrupt cleanup never runs.
    await started
    controller.abort()
    const result = await pending
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
    expect(interrupted).toEqual(["child-1"])
  })
})

describe("spawn — abort and deadlines", () => {
  test("an already-aborted signal short-circuits before the turn", async () => {
    const controller = new AbortController()
    controller.abort()
    const { host, turnCalls } = makeHost(),
     result = await spawn(host, options({ signal: controller.signal }))

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
    expect(turnCalls).toEqual([])
    // The child session was created before the turn; the abort starts at the prompt boundary.
    expect(getCoordinator().owns("child-1")).toBe(true)
  })

  test("aborting during the turn interrupts the child and reports aborted", async () => {
    const controller = new AbortController(),
     [started, markStarted] = gate(),
     { host, interrupted } = makeHost({
      turn: () => {
        markStarted()
        return new Promise(() => {})
      },
     }),
     pending = spawn(host, options({ signal: controller.signal }))

    // Attach the abort only after the turn is in flight, or promptChild short-circuits at entry.
    await started
    controller.abort()
    const result = await pending
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
    expect(interrupted).toEqual(["child-1"])
  })

  test("a wall-clock deadline interrupts the child and reports deadline", async () => {
    const { host, interrupted } = makeHost({ turn: () => new Promise(() => {}) }),
     result = await spawn(host, options({ deadlineMs: 1, idleMs: 0 }))

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("deadline")
    expect(interrupted).toEqual(["child-1"])
  })

  test("an idle kill reports idle-deadline and interrupts the child", async () => {
    const { host, interrupted } = makeHost({ turn: () => new Promise(() => {}) }),
     result = await spawn(host, options({ deadlineMs: 0, idleMs: 5 }))

    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("idle-deadline")
    expect(result.detail).toContain("made no progress")
    expect(interrupted).toEqual(["child-1"])
  })
})

describe("pure spawn primitives", () => {
  test("mintMessageID carries the V2 msg_ prefix and a fresh UUID body", () => {
    const first = mintMessageID()
    expect(first).toMatch(/^msg_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
    expect(mintMessageID()).not.toBe(first)
  })

  test("tokensOf truncates finite counts and refuses to propagate drift", () => {
    expect(tokensOf(12.9)).toBe(12)
    expect(tokensOf(-3)).toBe(0)
    expect(tokensOf(Number.NaN)).toBe(0)
    expect(tokensOf(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
