import { beforeEach, describe, expect, test } from "bun:test"
import { Run, type ProgressEvent, type RunOptions } from "../src/server/runtime/run.js"
import { registry } from "../src/server/singleton.js"
import { MAX_AGENTS_PER_RUN } from "../src/server/script/limits.js"
import type {
  AssistantErrorName,
  AssistantInfo,
  CreateSessionBody,
  MessagePart,
  OpencodeClient,
  PromptBody,
  PromptResponse,
  SessionInfo,
} from "../src/server/types.js"

// registry is process-wide (module-level) state by design, so every test must start from a clean
// slate or bleed into the next one.
beforeEach(() => {
  registry.resetForTests()
})

/** Minimal valid AssistantInfo, with `structured`/`error`/`outputTokens` added only when needed. */
function baseInfo(
  overrides: { structured?: unknown; error?: { name: AssistantErrorName }; outputTokens?: number } = {},
): AssistantInfo {
  return {
    id: "msg-1",
    sessionID: "session-1",
    role: "assistant",
    modelID: "model-1",
    providerID: "provider-1",
    cost: 0,
    tokens: { input: 0, output: overrides.outputTokens ?? 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0 },
    ...(overrides.structured === undefined ? {} : { structured: overrides.structured }),
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  }
}

function textPart(text: string): MessagePart {
  return { type: "text", text }
}

type CreateCall = { body?: CreateSessionBody; query?: { directory?: string } }
type PromptCall = { path: { id: string }; body: PromptBody }
type CreateResult = { data?: SessionInfo; error?: unknown }
type PromptResult = { data?: PromptResponse; error?: unknown }
type AbortResult = { data?: unknown; error?: unknown }

/**
 * A hand-rolled fake OpencodeClient — no mocking library. Records every call so tests can assert on
 * exactly what `agent()` (via `spawn()`) sent, and lets each test swap in custom behavior.
 *
 * Unlike spawn.test.ts's fake, `create` defaults to auto-incrementing session ids (`child-1`,
 * `child-2`, ...) so a single test can spawn several agents and tell their sessions apart — needed
 * for the abortAll() cases below.
 */
function makeClient(
  options: {
    create?: (call: CreateCall) => Promise<CreateResult>
    prompt?: (call: PromptCall) => Promise<PromptResult>
    abort?: (id: string) => Promise<AbortResult>
  } = {},
): { client: OpencodeClient; createCalls: CreateCall[]; promptCalls: PromptCall[]; abortCalls: string[] } {
  const createCalls: CreateCall[] = []
  const promptCalls: PromptCall[] = []
  const abortCalls: string[] = []
  let nextSessionId = 0

  const create =
    options.create ??
    ((): Promise<CreateResult> => {
      nextSessionId++
      return Promise.resolve({ data: { id: `child-${nextSessionId}` } })
    })
  const prompt =
    options.prompt ??
    ((): Promise<PromptResult> => Promise.resolve({ data: { info: baseInfo(), parts: [textPart("done")] } }))
  const abort = options.abort ?? ((): Promise<AbortResult> => Promise.resolve({ data: {} }))

  const client: OpencodeClient = {
    session: {
      create: (call: CreateCall) => {
        createCalls.push(call)
        return create(call)
      },
      get: () => Promise.resolve({ data: { id: "unused" } }),
      delete: () => Promise.resolve({}),
      abort: (call: { path: { id: string } }) => {
        abortCalls.push(call.path.id)
        return abort(call.path.id)
      },
      prompt: (call: PromptCall) => {
        promptCalls.push(call)
        return prompt(call)
      },
    },
  }

  return { client, createCalls, promptCalls, abortCalls }
}

/** A Run wired to run-1/parent-1 by default, with just the option overrides a test cares about. */
function makeRun(
  client: OpencodeClient,
  overrides: Partial<Omit<RunOptions, "runId" | "client" | "parentSessionID">> = {},
): Run {
  return new Run({ runId: "run-1", client, parentSessionID: "parent-1", ...overrides })
}

describe("Run.agent — happy path", () => {
  test("returns the last text part's text when no schema", async () => {
    const { client } = makeClient({
      prompt: () =>
        Promise.resolve({ data: { info: baseInfo({ outputTokens: 5 }), parts: [textPart("first"), textPart("second")] } }),
    })
    const run = makeRun(client)
    const result = await run.agent("do the thing")
    expect(result).toBe("second")
  })

  test("returns info.structured (NOT text) when a schema is supplied", async () => {
    const structured = { answer: 42 }
    const { client } = makeClient({
      prompt: () =>
        Promise.resolve({ data: { info: baseInfo({ structured, outputTokens: 5 }), parts: [textPart("ignored")] } }),
    })
    const run = makeRun(client)
    const result = await run.agent("do the thing", { schema: { type: "object" } })
    expect(result).toBe(structured)
    expect(result).not.toBe("ignored")
  })

  test("records one entry with ok:true, the right index, and outputTokens from info.tokens.output", async () => {
    const { client } = makeClient({
      prompt: () => Promise.resolve({ data: { info: baseInfo({ outputTokens: 17 }), parts: [textPart("hi")] } }),
    })
    const run = makeRun(client)
    await run.agent("do the thing")

    expect(run.records.length).toBe(1)
    const record = run.records[0]
    if (!record) throw new Error("expected a record")
    expect(record.ok).toBe(true)
    expect(record.index).toBe(0)
    expect(record.outputTokens).toBe(17)
  })

  test("agentCount increments with each spawn", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    expect(run.agentCount).toBe(0)
    await run.agent("first")
    expect(run.agentCount).toBe(1)
    await run.agent("second")
    expect(run.agentCount).toBe(2)
  })

  test("index is assigned in call order across multiple agents", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    await run.agent("first")
    await run.agent("second")
    expect(run.records.map((record) => record.index)).toEqual([0, 1])
  })
})

describe("Run.agent — failure", () => {
  test("a failing spawn (create returns no data) resolves to null, not throw", async () => {
    const { client } = makeClient({ create: () => Promise.resolve({ error: "boom" }) })
    const run = makeRun(client)
    const result = await run.agent("do the thing")
    expect(result).toBeNull()
  })

  test("the failure is recorded in run.nulls with a reason and detail", async () => {
    const { client } = makeClient({ create: () => Promise.resolve({ error: "boom" }) })
    const run = makeRun(client)
    await run.agent("do the thing")

    expect(run.nulls.length).toBe(1)
    const nullRecord = run.nulls[0]
    if (!nullRecord) throw new Error("expected a null record")
    expect(nullRecord.reason).toBe("spawn-failed")
    expect(nullRecord.detail).toBe("boom")
    // create() never produced a session, so there is nothing to key a sessionID off of.
    expect(nullRecord.sessionID).toBeUndefined()
  })

  test("a failure AFTER a session was created (prompt-failed) still carries the sessionID", async () => {
    const { client } = makeClient({ prompt: () => Promise.resolve({ error: "server exploded" }) })
    const run = makeRun(client)
    await run.agent("do the thing")

    const nullRecord = run.nulls[0]
    if (!nullRecord) throw new Error("expected a null record")
    expect(nullRecord.reason).toBe("prompt-failed")
    expect(nullRecord.sessionID).toBe("child-1")
  })

  test("run.outputTokens counts only successful agents", async () => {
    let createCallCount = 0
    const { client } = makeClient({
      create: () => {
        createCallCount++
        return createCallCount === 1 ? Promise.resolve({ data: { id: "child-1" } }) : Promise.resolve({ error: "boom" })
      },
      prompt: () => Promise.resolve({ data: { info: baseInfo({ outputTokens: 20 }), parts: [textPart("ok")] } }),
    })
    const run = makeRun(client)
    await run.agent("first")
    await run.agent("second")
    expect(run.outputTokens).toBe(20)
  })
})

describe("Run.agent — labels", () => {
  test("an explicit label is used", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    await run.agent("do the thing", { label: "custom-label" })
    const record = run.records[0]
    if (!record) throw new Error("expected a record")
    expect(record.label).toBe("custom-label")
  })

  test("no label derives one from the prompt's first line, truncated to 48 characters", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    const longLine = "y".repeat(80)
    await run.agent(`${longLine}\nsecond line is ignored`)
    const record = run.records[0]
    if (!record) throw new Error("expected a record")
    expect(record.label).toBe(longLine.slice(0, 48))
    expect(record.label.length).toBe(48)
  })

  // NOTE (source finding, not a bug we can fix here): deriveLabel()'s `agent:${index}` fallback
  // fires only when `prompt.trim().split("\n", 1)[0]`, sliced to 48 chars and re-trimmed, is "".
  // Since `String#trim()` strips ALL leading whitespace before the split runs, that can only happen
  // when the ENTIRE prompt is whitespace — and agent() already throws a TypeError for exactly that
  // input one line above the call to deriveLabel (see the "validation" describe block below). So
  // the `agent:<index>` fallback can never actually execute through the public agent() API; it is
  // unreachable dead code as currently guarded. We cannot exercise it without either modifying
  // run.ts (not allowed) or calling the unexported deriveLabel() directly (also not exported).
})

describe("Run.phase()", () => {
  test("sets run.currentPhase and it is used for subsequent agents", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    run.phase("discovery")
    expect(run.currentPhase).toBe("discovery")

    await run.agent("do the thing")
    const record = run.records[0]
    if (!record) throw new Error("expected a record")
    expect(record.phase).toBe("discovery")
  })

  test("an explicit opts.phase overrides the current phase for that agent only", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    run.phase("discovery")
    await run.agent("first", { phase: "override" })
    await run.agent("second")

    const first = run.records[0]
    const second = run.records[1]
    if (!first || !second) throw new Error("expected two records")
    expect(first.phase).toBe("override")
    expect(second.phase).toBe("discovery")
  })
})

describe("Run.agent — validation and caps", () => {
  test("a non-string prompt throws a TypeError", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    await expect(run.agent(42 as unknown as string)).rejects.toThrow(TypeError)
  })

  test("an empty or whitespace-only prompt throws a TypeError", async () => {
    const { client } = makeClient()
    const run = makeRun(client)
    await expect(run.agent("")).rejects.toThrow(TypeError)
    await expect(run.agent("   \n\t  ")).rejects.toThrow(TypeError)
  })

  test("the lifetime cap rejects the call past MAX_AGENTS_PER_RUN without inflating agentCount", async () => {
    // MAX_AGENTS_PER_RUN (1000) is a runaway-loop backstop, not a tuning knob — this drives the cap
    // itself rather than spawning 1000 real agents end to end. `#spawned` is checked and incremented
    // SYNCHRONOUSLY, before the first `await` inside agent() — so firing every call in one tight
    // loop (no `await` between them) claims all MAX_AGENTS_PER_RUN indices before any of them has
    // actually spawned. The fake client's create() fails immediately, so each spawn that does run
    // settles in a handful of microtasks — the whole loop completes in well under a second.
    registry.configureConcurrency(32)
    const { client } = makeClient({ create: () => Promise.resolve({ error: "cap-test" }) })
    const run = makeRun(client)

    const promises: Promise<unknown>[] = []
    for (let i = 0; i < MAX_AGENTS_PER_RUN; i++) {
      promises.push(run.agent(`prompt ${i}`))
    }
    // Already at the cap — claimed synchronously by the loop above, before any spawn has settled.
    expect(run.agentCount).toBe(MAX_AGENTS_PER_RUN)

    const overflow = run.agent("prompt over the cap")
    await expect(overflow).rejects.toThrow(String(MAX_AGENTS_PER_RUN))
    // The rejected call must not have inflated the counter it was rejected for exceeding.
    expect(run.agentCount).toBe(MAX_AGENTS_PER_RUN)

    await Promise.all(promises)
  })
})

describe("Run.agent — concurrency", () => {
  test("the semaphore is respected: at most the configured limit of prompts run at once", async () => {
    registry.configureConcurrency(2)
    let inFlight = 0
    let peak = 0
    const { client } = makeClient({
      prompt: () =>
        new Promise((resolve) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          setTimeout(() => {
            inFlight--
            resolve({ data: { info: baseInfo(), parts: [textPart("done")] } })
          }, 0)
        }),
    })
    const run = makeRun(client)

    await Promise.all(Array.from({ length: 6 }, (_unused, i) => run.agent(`prompt ${i}`)))

    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1)
    expect(inFlight).toBe(0)
  })

  test("the permit is released even when spawn fails, so failing agents never deadlock", async () => {
    registry.configureConcurrency(2)
    const { client } = makeClient({ create: () => Promise.resolve({ error: "boom" }) })
    const run = makeRun(client)

    const results = await Promise.all(Array.from({ length: 6 }, (_unused, i) => run.agent(`prompt ${i}`)))

    expect(results.every((result) => result === null)).toBe(true)
    expect(run.nulls.length).toBe(6)
  })
})

describe("progress", () => {
  test("onProgress fires agent-start before agent-end for an agent, plus phase and log events", async () => {
    const events: ProgressEvent[] = []
    const { client } = makeClient()
    const run = makeRun(client, { onProgress: (event) => events.push(event) })

    run.phase("discovery")
    run.log("starting up")
    await run.agent("do the thing")

    const startIndex = events.findIndex((event) => event.type === "agent-start")
    const endIndex = events.findIndex((event) => event.type === "agent-end")
    expect(startIndex).toBeGreaterThanOrEqual(0)
    expect(endIndex).toBeGreaterThan(startIndex)

    expect(events.some((event) => event.type === "phase" && event.title === "discovery")).toBe(true)
    expect(events.some((event) => event.type === "log" && event.message === "starting up")).toBe(true)
  })

  test("log() appends to run.logs", () => {
    const { client } = makeClient()
    const run = makeRun(client)
    run.log("hello")
    run.log("world")
    expect(run.logs).toEqual(["hello", "world"])
  })
})

describe("abortAll", () => {
  test("calls client.session.abort once per child session and clears them from the registry", async () => {
    const { client, abortCalls } = makeClient()
    const run = makeRun(client)
    await run.agent("first")
    await run.agent("second")
    expect(registry.sessionsOf("run-1").length).toBe(2)

    await run.abortAll()

    expect(abortCalls.toSorted()).toEqual(["child-1", "child-2"])
    expect(registry.sessionsOf("run-1")).toEqual([])
  })

  test("an abort that rejects does not make abortAll() reject", async () => {
    const { client } = makeClient({ abort: () => Promise.reject(new Error("remote abort endpoint is down")) })
    const run = makeRun(client)
    await run.agent("first")

    await expect(run.abortAll()).resolves.toBeUndefined()
    expect(registry.sessionsOf("run-1")).toEqual([])
  })
})

describe("option plumbing", () => {
  test("resolveModel/resolveVariant/subagentContract results reach the prompt body", async () => {
    const { client, promptCalls } = makeClient()
    const run = makeRun(client, {
      resolveModel: () => ({ providerID: "anthropic", modelID: "claude-x" }),
      resolveVariant: () => "high",
      subagentContract: () => "extra contract text",
    })
    await run.agent("do the thing", { model: "anthropic/claude-x", effort: "high" })

    const promptBody = promptCalls[0]?.body
    if (!promptBody) throw new Error("expected a prompt call")
    expect(promptBody.model).toEqual({ providerID: "anthropic", modelID: "claude-x" })
    expect(promptBody.variant).toBe("high")
    expect(promptBody.system).toBe("extra contract text")
  })

  test("when the resolvers return undefined, the corresponding keys are absent from the prompt body", async () => {
    const { client, promptCalls } = makeClient()
    const run = makeRun(client, {
      resolveModel: () => undefined,
      resolveVariant: () => undefined,
      subagentContract: () => undefined,
    })
    await run.agent("do the thing")

    const promptBody = promptCalls[0]?.body
    if (!promptBody) throw new Error("expected a prompt call")
    expect("model" in promptBody).toBe(false)
    expect("variant" in promptBody).toBe(false)
    expect("system" in promptBody).toBe(false)
  })
})

describe("Run.agent — defensive token extraction", () => {
  test("a response with no tokens field degrades to 0 rather than crashing the run", async () => {
    // Regression: `outcome.info.tokens.output` threw "undefined is not an object" on a message
    // without a tokens field. Inside parallel() that was caught into a null, but a bare
    // `await agent(...)` killed the whole workflow with an opaque error. The SDK types have
    // already drifted from the server once, so an unexpected shape must not be fatal.
    // Casts are deliberate: these fixtures are INVALID by the declared types, which is exactly
    // the situation being guarded against — the server returning a shape the SDK types promise
    // cannot happen.
    const { client } = makeClient({
      prompt: () => Promise.resolve({ data: { info: {}, parts: [textPart("fine")] } } as unknown as PromptResult),
    })
    const run = makeRun(client)

    expect(await run.agent("x")).toBe("fine")
    expect(run.outputTokens).toBe(0)
    expect(run.nulls.length).toBe(0)
  })

  test("a non-numeric token count is ignored", async () => {
    const { client } = makeClient({
      prompt: () =>
        Promise.resolve({
          data: { info: { tokens: { output: "lots" } }, parts: [textPart("fine")] },
        } as unknown as PromptResult),
    })
    const run = makeRun(client)
    await run.agent("x")
    expect(run.outputTokens).toBe(0)
  })
})
