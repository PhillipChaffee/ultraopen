import { beforeEach, describe, expect, test } from "bun:test"
import { interpret, spawn } from "../src/server/bridge/spawn.js"
import { registry } from "../src/server/singleton.js"
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

/** Minimal valid AssistantInfo, with `structured`/`error` added only when a test needs them. */
function baseInfo(overrides: { structured?: unknown; error?: { name: AssistantErrorName } } = {}): AssistantInfo {
  return {
    id: "msg-1",
    sessionID: "session-1",
    role: "assistant",
    modelID: "model-1",
    providerID: "provider-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0 },
    ...(overrides.structured === undefined ? {} : { structured: overrides.structured }),
    ...(overrides.error === undefined ? {} : { error: overrides.error }),
  }
}

function textPart(text: string): MessagePart {
  return { type: "text", text }
}

interface CreateCall { body?: CreateSessionBody; query?: { directory?: string } }
interface PromptCall { path: { id: string }; body: PromptBody }
interface CreateResult { data?: SessionInfo; error?: unknown }
interface PromptResult { data?: PromptResponse; error?: unknown }
interface AbortResult { data?: unknown; error?: unknown }

/**
 * A hand-rolled fake OpencodeClient — no mocking library. Records every call so tests can assert
 * on exactly what spawn() sent, and lets each test swap in custom create/prompt/abort behavior.
 */
function makeClient(
  options: {
    create?: (call: CreateCall) => Promise<CreateResult>
    prompt?: (call: PromptCall) => Promise<PromptResult>
    abort?: (id: string) => Promise<AbortResult>
  } = {},
): { client: OpencodeClient; createCalls: CreateCall[]; promptCalls: PromptCall[]; abortCalls: string[] } {
  const createCalls: CreateCall[] = [],
   promptCalls: PromptCall[] = [],
   abortCalls: string[] = [],

   create = options.create ?? ((): Promise<CreateResult> => Promise.resolve({ data: { id: "child-1" } })),
   prompt =
    options.prompt ??
    ((): Promise<PromptResult> => Promise.resolve({ data: { info: baseInfo(), parts: [textPart("done")] } })),
   abort = options.abort ?? ((): Promise<AbortResult> => Promise.resolve({ data: {} })),

   client: OpencodeClient = {
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

describe("interpret", () => {
  test("no schema + text parts -> ok:true with the LAST text part's text", () => {
    const response: PromptResponse = { info: baseInfo(), parts: [textPart("first"), textPart("second")] },
     result = interpret(response, "session-1", false)
    if (!result.ok) {throw new Error("expected success")}
    expect(result.text).toBe("second")
  })

  test("no schema + no text parts -> ok:true and text is empty string", () => {
    const response: PromptResponse = { info: baseInfo(), parts: [{ type: "tool", tool: "bash" }] },
     result = interpret(response, "session-1", false)
    if (!result.ok) {throw new Error("expected success")}
    expect(result.text).toBe("")
  })

  test("schema + info.structured set -> ok:true and structured passed through", () => {
    const structured = { answer: 42 },
     response: PromptResponse = { info: baseInfo({ structured }), parts: [textPart("ignored")] },
     result = interpret(response, "session-1", true)
    if (!result.ok) {throw new Error("expected success")}
    expect(result.structured).toBe(structured)
    expect(result.text).toBe("ignored")
  })

  test("schema + structured undefined and no error -> reason:schema-failed", () => {
    // This is the auto-compaction case: the host strips `format` from the message it inserts when
    // it compacts, and reports no error at all — the run comes back as plain text with
    // `error === undefined`, so a missing `structured` is the ONLY signal available.
    const response: PromptResponse = { info: baseInfo(), parts: [] },
     result = interpret(response, "session-1", true)
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("schema-failed")
  })

  test('info.error.name === "MessageAbortedError" -> reason:aborted', () => {
    const response: PromptResponse = { info: baseInfo({ error: { name: "MessageAbortedError" } }), parts: [] },
     result = interpret(response, "session-1", false)
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
  })

  test('info.error.name === "ContextOverflowError" -> reason:context-overflow', () => {
    const response: PromptResponse = { info: baseInfo({ error: { name: "ContextOverflowError" } }), parts: [] },
     result = interpret(response, "session-1", false)
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("context-overflow")
  })

  test.each<AssistantErrorName>(["APIError", "ProviderAuthError"])(
    "any other error name (%s) -> reason:api-error with the name in detail",
    (name) => {
      const response: PromptResponse = { info: baseInfo({ error: { name } }), parts: [] },
       result = interpret(response, "session-1", false)
      if (result.ok) {throw new Error("expected failure")}
      expect(result.reason).toBe("api-error")
      expect(result.detail).toBe(name)
    },
  )

  test("an error takes precedence over a present structured value", () => {
    const response: PromptResponse = {
      info: baseInfo({ structured: { ok: true }, error: { name: "MessageAbortedError" } }),
      parts: [],
    },
     result = interpret(response, "session-1", true)
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
  })
})

describe("spawn", () => {
  test("happy path: create body carries parentID/permission/metadata.ultraopen.runId; prompt body carries the rest", async () => {
    const schema = { type: "object" },
    // A schema was supplied, so the fake must answer with `structured` set — otherwise interpret()
    // reports schema-failed and this test would be asserting on a failure outcome by accident.
     { client, createCalls, promptCalls } = makeClient({
      prompt: () => Promise.resolve({ data: { info: baseInfo({ structured: { done: true } }), parts: [] } }),
    }),

     result = await spawn(client, {
      prompt: "do the thing",
      runId: "run-1",
      parentSessionID: "parent-1",
      label: "worker",
      agentType: "reviewer",
      model: { providerID: "anthropic", modelID: "claude" },
      variant: "high",
      system: "extra instructions",
      schema,
    })
    expect(result.ok).toBe(true)

    const createCall = createCalls[0]
    if (!createCall) {throw new Error("expected a create call")}
    const createBody = createCall.body
    if (!createBody) {throw new Error("expected a create body")}
    expect(createBody.parentID).toBe("parent-1")
    expect(Array.isArray(createBody.permission)).toBe(true)
    expect(createBody.metadata?.["ultraopen"]).toEqual({ runId: "run-1", label: "worker" })

    // create({agent}) is cosmetic — the agent that actually governs the turn is on the PROMPT body.
    const promptCall = promptCalls[0]
    if (!promptCall) {throw new Error("expected a prompt call")}
    const promptBody = promptCall.body
    expect(promptBody.agent).toBe("reviewer")
    expect(promptBody.model).toEqual({ providerID: "anthropic", modelID: "claude" })
    expect(promptBody.variant).toBe("high")
    expect(promptBody.system).toBe("extra instructions")
    expect(promptBody.format).toEqual({ type: "json_schema", schema })
  })

  test("format is present only when schema is supplied, shaped as {type:json_schema, schema}", async () => {
    const { client, promptCalls } = makeClient(),
     schema = { type: "object", properties: {} }
    await spawn(client, { prompt: "p", runId: "run-1", parentSessionID: "parent-1", label: "worker", schema })
    const promptBody = promptCalls[0]?.body
    if (!promptBody) {throw new Error("expected a prompt call")}
    expect(promptBody.format).toEqual({ type: "json_schema", schema })
  })

  test("the session id is registered after a successful spawn", async () => {
    const { client } = makeClient(),
     result = await spawn(client, { prompt: "p", runId: "run-1", parentSessionID: "parent-1", label: "worker" })
    if (!result.ok) {throw new Error("expected success")}
    expect(registry.owns(result.sessionID)).toBe(true)
  })

  test("create returns no data -> reason:spawn-failed and nothing is registered", async () => {
    const { client } = makeClient({ create: () => Promise.resolve({ error: new Error("boom") }) }),
     result = await spawn(client, { prompt: "p", runId: "run-1", parentSessionID: "parent-1", label: "worker" })
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("spawn-failed")
    expect(registry.size).toBe(0)
  })

  test("prompt returns no data -> reason:prompt-failed with sessionID present", async () => {
    const { client } = makeClient({ prompt: () => Promise.resolve({ error: "server error" }) }),
     result = await spawn(client, { prompt: "p", runId: "run-1", parentSessionID: "parent-1", label: "worker" })
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("prompt-failed")
    expect(result.sessionID).toBe("child-1")
  })

  test("prompt throws -> reason:prompt-failed", async () => {
    const { client } = makeClient({ prompt: () => Promise.reject(new Error("network down")) }),
     result = await spawn(client, { prompt: "p", runId: "run-1", parentSessionID: "parent-1", label: "worker" })
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("prompt-failed")
  })

  test("an already-aborted signal short-circuits before prompting", async () => {
    const { client, promptCalls } = makeClient(),
     controller = new AbortController()
    controller.abort()

    const result = await spawn(client, {
      prompt: "p",
      runId: "run-1",
      parentSessionID: "parent-1",
      label: "worker",
      signal: controller.signal,
    })
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
    expect(promptCalls.length).toBe(0)
  })

  test("aborting the signal DURING the prompt calls client.session.abort with the child id", async () => {
    const controller = new AbortController()
    let resolvePrompt: ((value: PromptResult) => void) | undefined,
     abortSeen: (() => void) | undefined
    const abortSeenPromise = new Promise<void>((resolve) => {
      abortSeen = resolve
    }),

     { client, abortCalls } = makeClient({
      prompt: () =>
        new Promise((resolve) => {
          resolvePrompt = resolve
          // Simulate the abort landing while the remote prompt is still in flight.
          controller.abort()
        }),
      // A rejecting abort call must be swallowed (spawn.ts chains `.catch(() => undefined)`) rather
      // than surfacing as an unhandled rejection or masking the real outcome below.
      abort: (): Promise<AbortResult> => {
        abortSeen?.()
        return Promise.reject(new Error("remote abort endpoint is down"))
      },
    }),

     outcome = spawn(client, {
      prompt: "p",
      runId: "run-1",
      parentSessionID: "parent-1",
      label: "worker",
      signal: controller.signal,
    })

    // Wait for the abort call to actually land before inspecting it or resolving the prompt.
    await abortSeenPromise
    expect(abortCalls).toEqual(["child-1"])

    resolvePrompt?.({ data: { info: baseInfo(), parts: [] } })
    await outcome
  })

  test("when the prompt rejects and the signal is aborted, reason is aborted, not prompt-failed", async () => {
    const controller = new AbortController(),
     { client } = makeClient({
      prompt: () => {
        controller.abort()
        return Promise.reject(new Error("connection reset"))
      },
    }),

     result = await spawn(client, {
      prompt: "p",
      runId: "run-1",
      parentSessionID: "parent-1",
      label: "worker",
      signal: controller.signal,
    })
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("aborted")
  })

  test("a deadline stops the remote run: deadlineMs:1 with a prompt that never resolves -> reason:deadline", async () => {
    const { client, abortCalls } = makeClient({
      prompt: () => new Promise(() => {}),
    }),

     result = await spawn(client, {
      prompt: "p",
      runId: "run-1",
      parentSessionID: "parent-1",
      label: "worker",
      deadlineMs: 1,
    })
    if (result.ok) {throw new Error("expected failure")}
    expect(result.reason).toBe("deadline")
    // The deadline must actually stop the remote run, not just give up locally.
    expect(abortCalls).toEqual(["child-1"])
  })

  test("optional fields are omitted from both bodies when not supplied", async () => {
    const { client, createCalls, promptCalls } = makeClient()
    await spawn(client, { prompt: "p", runId: "run-1", parentSessionID: "parent-1", label: "worker" })

    const createBody = createCalls[0]?.body
    if (!createBody) {throw new Error("expected a create body")}
    expect("agent" in createBody).toBe(false)

    const promptBody = promptCalls[0]?.body
    if (!promptBody) {throw new Error("expected a prompt call")}
    expect("agent" in promptBody).toBe(false)
    expect("model" in promptBody).toBe(false)
    expect("variant" in promptBody).toBe(false)
    expect("system" in promptBody).toBe(false)
    expect("format" in promptBody).toBe(false)
  })

  // The internal `describe()` helper has more branches than any single required case exercises —
  // these two close out its remaining formatting paths so spawn.ts hits 100% line coverage.
  describe("failure detail formatting", () => {
    test("an error-shaped object with a name but no message falls back to that name", async () => {
      const { client } = makeClient({ create: () => Promise.resolve({ error: { name: "WeirdError" } }) }),
       result = await spawn(client, {
        prompt: "p",
        runId: "run-1",
        parentSessionID: "parent-1",
        label: "worker",
      })
      if (result.ok) {throw new Error("expected failure")}
      expect(result.detail).toBe("WeirdError")
    })

    test("an error with no recognizable shape falls back to JSON.stringify", async () => {
      const { client } = makeClient({ prompt: () => Promise.resolve({ error: 42 }) }),
       result = await spawn(client, {
        prompt: "p",
        runId: "run-1",
        parentSessionID: "parent-1",
        label: "worker",
      })
      if (result.ok) {throw new Error("expected failure")}
      expect(result.detail).toBe("42")
    })
  })
})
