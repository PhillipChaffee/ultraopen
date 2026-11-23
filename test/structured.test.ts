import { beforeEach, describe, expect, test } from "bun:test"
import { spawnStructured } from "../src/server/bridge/structured.js"
import { isObjectRootSchema, normalizeStructuredSchema, unwrapCaptured } from "../src/server/bridge/validate.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ChildSessionRecord } from "../src/server/runtime/coordinator.js"
import type { HostPort, HostTurnResult } from "../src/server/host/port.js"

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
}

type TurnResult = { ok: true; turn: HostTurnResult } | { ok: false; detail: string }

/** One scripted turn: the capture the (simulated) StructuredOutput tool records, if any. */
interface Scripted {
  capture?: unknown
  text?: string
  outputTokens?: number
  outcome?: HostTurnResult["outcome"]
  error?: { type: string; message: string }
  transportFailure?: string
}

/**
 * A fake host whose turns are scripted per attempt, writing into the coordinator's capture slot
 * exactly as the real `StructuredOutput` tool executor does.
 */
function makeHost(responses: (Scripted | "no-data")[]) {
  const turns: { sessionID: string; messageID: string; text: string }[] = []
  let index = 0,
   sessionCount = 0
  const coordinator = getCoordinator()

  const host: HostPort = {
    location: { directory: "/work", canonical: "/canonical/work", projectID: "project-1" },
    defaultModel: () => Promise.resolve(undefined),
    listModels: () => Promise.resolve([]),
    getSession: () => Promise.resolve(undefined),
    getAgent: () => Promise.resolve(undefined),
    listAgents: () => Promise.resolve([]),
    listPendingPermissions: () => Promise.resolve([]),
    rejectPermission: () => Promise.resolve(),
    createChildSession: () => {
      sessionCount++
      return Promise.resolve({ ok: true, sessionID: `child-${sessionCount}` })
    },
    moveSession: () => Promise.resolve({ ok: true }),
    runTurn: (input) => {
      turns.push(input)
      const next = responses[Math.min(index, responses.length - 1)]
      index++
      if (next === undefined) {throw new Error("the test scripted no response")}
      return Promise.resolve(settle(next, coordinator.childOf(input.sessionID)))
    },
    interruptSession: () => Promise.resolve(true),
    admitSynthetic: () => Promise.resolve("admitted"),
  }
  return { host, turns }
}

function settle(next: Scripted | "no-data", record: ChildSessionRecord | undefined): TurnResult {
  if (next === "no-data") {return { ok: false, detail: "boom" }}
  if (next.transportFailure !== undefined) {return { ok: false, detail: next.transportFailure }}
  if (next.capture !== undefined && record !== undefined) {
    record.captured = { value: next.capture, attempt: record.currentAttempt }
  }
  return {
    ok: true,
    turn: {
      outcome: next.outcome ?? "succeeded",
      text: next.text ?? "",
      outputTokens: next.outputTokens ?? 1,
      ...(next.error === undefined ? {} : { error: next.error }),
    },
  }
}

function options(overrides: Partial<Parameters<typeof spawnStructured>[1]> = {}) {
  return {
    prompt: "do the work",
    runId: "run-1",
    parentSessionID: "parent",
    ancestorSessionIDs: [],
    projectKey: "project-key",
    coordinator: getCoordinator(),
    label: "worker",
    ...overrides,
  }
}

const withSchema = (overrides: Partial<Parameters<typeof spawnStructured>[1]> = {}) => options({ schema: SCHEMA, ...overrides })

beforeEach(() => {
  resetCoordinatorForTests()
})

describe("happy path", () => {
  test("returns on the first attempt when the capture is valid", async () => {
    const { host, turns } = makeHost([{ capture: { answer: "yes" } }]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(turns.length).toBe(1)
    expect(turns[0]?.messageID.startsWith("msg_")).toBe(true)
    if (result.ok) {expect(result.structured).toEqual({ answer: "yes" })}
    expect(getCoordinator().childOf("child-1")?.currentAttempt).toBe(1)
  })

  test("a call without a schema runs exactly once and returns text", async () => {
    const { host, turns } = makeHost([{ text: "plain", outputTokens: 4 }]),
     result = await spawnStructured(host, options())

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(turns.length).toBe(1)
    if (result.ok) {
      expect(result.text).toBe("plain")
      expect(result.outputTokens).toBe(4)
    }
  })
})

describe("retry ladder", () => {
  test("retries in the SAME session and eventually succeeds", async () => {
    const { host, turns } = makeHost([{ text: "prose" }, { capture: { answer: "yes" } }]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    // Same session across attempts: this preserves the child's research.
    expect(turns.map((turn) => turn.sessionID)).toEqual(["child-1", "child-1"])
  })

  test("accumulates outputTokens across every attempt, successful or not", async () => {
    const { host } = makeHost([
      { text: "prose", outputTokens: 5 },
      { capture: { answer: "yes" }, outputTokens: 7 },
    ]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(true)
    expect(result.outputTokens).toBe(12)
  })

  test("clears the previous attempt's capture so a stale value cannot satisfy the next", async () => {
    const coordinator = getCoordinator(),
     { host, turns } = makeHost([
      // Wrong shape: fails local validation, so the stale capture must be discarded.
      { capture: { wrong: 1 } },
      { capture: { answer: "ok" } },
     ]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(turns.length).toBe(2)
    expect(coordinator.childOf("child-1")?.currentAttempt).toBe(2)
    expect(coordinator.childOf("child-1")?.lastValidationErrors).toBeUndefined()
  })

  test("the retry prompt names the required fields", async () => {
    const { host, turns } = makeHost([{ text: "prose" }])
    await spawnStructured(host, withSchema())
    const second = turns[1]?.text ?? ""
    expect(second).toContain("did not produce valid structured output")
    expect(second).toContain("answer (string)")
  })

  test("the third attempt adds a worked example", async () => {
    const { host, turns } = makeHost([{ text: "prose" }])
    await spawnStructured(host, withSchema())
    const third = turns[2]?.text ?? ""
    expect(third).toContain("A valid shape looks like")
    expect(third).toContain('"answer"')
  })

  test("gives up after three attempts with a descriptive reason and the accumulated spend", async () => {
    const { host } = makeHost([{ text: "prose", outputTokens: 5 }]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(3)
    expect(result.outputTokens).toBe(15)
    if (!result.ok) {
      expect(result.reason).toBe("schema-failed")
      expect(result.detail).toContain("after 3 attempts")
    }
  })

  test("an untyped schema still ladders three times without crashing", async () => {
    const { host, turns } = makeHost([{ text: "prose" }])
    await spawnStructured(host, options({ schema: { required: ["x"] } }))
    expect(turns.length).toBe(3)
  })
})

describe("non-retryable outcomes", () => {
  test.each([
    [{ outcome: "interrupted" }, "aborted"],
    [{ error: { type: "ContextOverflowError", message: "too long" } }, "context-overflow"],
    [{ error: { type: "ProviderAuthError", message: "bad key" } }, "api-error"],
  ] as const)("%s stops immediately rather than retrying", async (scripted, expectedReason) => {
    // Retrying an aborted run would fight the user; an auth failure or an exhausted context will
    // not improve by asking again.
    const { host, turns } = makeHost([{ ...scripted, outputTokens: 3 }]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(false)
    if (!result.ok) {expect(result.reason).toBe(expectedReason)}
    expect(turns.length).toBe(1)
    // The failed turn still spent tokens, and that spend counts.
    expect(result.outputTokens).toBe(3)
  })

  test("a failed session creation reports the real reason", async () => {
    const host = makeHost([]).host,
     broken: HostPort = { ...host, createChildSession: () => Promise.resolve({ ok: false, detail: "BadRequest" }) },
     result = await spawnStructured(broken, withSchema())

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(0)
    if (!result.ok) {
      expect(result.reason).toBe("spawn-failed")
      expect(result.detail).toBe("BadRequest")
    }
  })

  test("a transport failure is not retried as a schema miss", async () => {
    const { host, turns } = makeHost(["no-data"]),
     result = await spawnStructured(host, withSchema())

    expect(result.ok).toBe(false)
    if (!result.ok) {expect(result.reason).toBe("api-error")}
    expect(turns.length).toBe(1)
  })
})

describe("nudge construction", () => {
  test("handles a schema with no required list", async () => {
    const loose = { type: "object", properties: { a: { type: "string" } } },
     { host, turns } = makeHost([{ text: "prose" }])
    await spawnStructured(host, options({ schema: loose }))

    const second = turns[1]?.text ?? ""
    expect(second).toContain("StructuredOutput")
    expect(second).not.toContain("Required fields:")
  })

  test("builds an example for arrays, enums and primitives", async () => {
    const complex = {
      type: "object",
      required: ["items", "level", "count", "flag", "nothing"],
      properties: {
        items: { type: "array", items: { type: "string" } },
        level: { enum: ["high", "low"] },
        count: { type: "integer" },
        flag: { type: "boolean" },
        nothing: { type: "null" },
      },
    },
     { host, turns } = makeHost([{ text: "prose" }])
    await spawnStructured(host, options({ schema: complex }))

    const third = turns[2]?.text ?? ""
    expect(third).toContain('"level": "high"')
    expect(third).toContain('"count": 0')
    expect(third).toContain('"flag": false')
    expect(third).toContain('"nothing": null')
  })

  test("handles a property type the example builder does not model", async () => {
    const odd = {
      type: "object",
      required: ["mystery"],
      properties: { mystery: { type: "quantum" } },
     },
     { host, turns } = makeHost([{ text: "prose" }])
    await spawnStructured(host, options({ schema: odd }))
    expect(turns[2]?.text).toContain('"mystery": "…"')
  })
})

describe("validate.ts — structured schema envelope", () => {
  test("owns the structured schema envelope wrap and unwrap contract", () => {
    expect(isObjectRootSchema({ type: "object" })).toBe(true)
    expect(isObjectRootSchema({ type: "number" })).toBe(false)
    expect(normalizeStructuredSchema({ type: "number" })).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    })
    expect(unwrapCaptured({ value: 42 }, true)).toBe(42)
    expect(unwrapCaptured({ a: 1 }, false)).toEqual({ a: 1 })
  })

  test("leaves an object-root schema untouched and tolerates a primitive capture", () => {
    const schema = { properties: { a: { type: "string" } } }
    expect(isObjectRootSchema(schema)).toBe(true)
    expect(normalizeStructuredSchema(schema)).toBe(schema)
    expect(unwrapCaptured("text", true)).toBe("text")
    expect(unwrapCaptured(null, true)).toBeNull()
  })
})
