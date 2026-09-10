import { beforeEach, describe, expect, test } from "bun:test"
import { spawnStructured } from "../src/server/bridge/structured.js"
import { registry } from "../src/server/singleton.js"
import type { OpencodeClient, PromptBody, PromptResponse } from "../src/server/types.js"

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
}

interface PromptCall { body: PromptBody }

/** Fake client whose prompt behaviour is scripted per attempt. */
function makeClient(responses: (Partial<PromptResponse> | "no-data")[]) {
  const prompts: PromptCall[] = []
  let index = 0
  const client = {
    session: {
      create: () => Promise.resolve({ data: { id: "child-1" } }),
      get: () => Promise.resolve({ data: { id: "child-1" } }),
      delete: () => Promise.resolve({}),
      abort: () => Promise.resolve({}),
      prompt: (options: { path: { id: string }; body: PromptBody }) => {
        prompts.push({ body: options.body })
        const next = responses[Math.min(index, responses.length - 1)]
        index++
        if (next === "no-data") {return Promise.resolve({ error: "boom" })}
        return Promise.resolve({
          data: { info: { tokens: { output: 1 } }, parts: [], ...next } as unknown as PromptResponse,
        })
      },
    },
  } as unknown as OpencodeClient
  return { client, prompts }
}

const options = {
  prompt: "do the work",
  runId: "run-1",
  parentSessionID: "parent",
  label: "worker",
  schema: SCHEMA,
}

beforeEach(() => {
  registry.resetForTests()
})

describe("happy path", () => {
  test("returns on the first attempt when the value is valid", async () => {
    const { client, prompts } = makeClient([{ info: { structured: { answer: "yes" } } } as Partial<PromptResponse>]),
     result = await spawnStructured(client, options)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(prompts.length).toBe(1)
  })

  test("sends format on the request", async () => {
    const { client, prompts } = makeClient([{ info: { structured: { answer: "yes" } } } as Partial<PromptResponse>])
    await spawnStructured(client, options)
    expect(prompts[0]?.body.format).toEqual({ type: "json_schema", schema: SCHEMA })
  })

  test("a call without a schema runs exactly once", async () => {
    const { client, prompts: noSchemaPrompts } = makeClient([{ parts: [{ type: "text", text: "plain" }] } as Partial<PromptResponse>]),
     result = await spawnStructured(client, { ...options, schema: undefined })

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(1)
    expect(noSchemaPrompts[0]?.body.format).toBeUndefined()
  })
})

describe("retry ladder", () => {
  test("retries in the SAME session and eventually succeeds", async () => {
    const { client } = makeClient([
      { info: {} } as Partial<PromptResponse>,
      { info: { structured: { answer: "yes" } } } as Partial<PromptResponse>,
    ]),
     result = await spawnStructured(client, options)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    // Same session across attempts: this is what preserves the child's research and is the only
    // construction that can repair a compaction-stripped `format`.
    expect(registry.sessionsOf("run-1")).toEqual(["child-1"])
  })

  test("resends format on every retry", async () => {
    // The host reads `format` off the LATEST user message, so a retry without it silently
    // degrades to an unstructured turn.
    const { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>])
    await spawnStructured(client, options)
    expect(prompts.length).toBe(3)
    for (const call of prompts) {expect(call.body.format).toBeDefined()}
  })

  test("the retry prompt names the required fields", async () => {
    const { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>])
    await spawnStructured(client, options)
    const second = prompts[1]?.body.parts[0]?.text ?? ""
    expect(second).toContain("did not produce valid structured output")
    expect(second).toContain("answer (string)")
  })

  test("the third attempt adds a worked example", async () => {
    const { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>])
    await spawnStructured(client, options)
    const third = prompts[2]?.body.parts[0]?.text ?? ""
    expect(third).toContain("A valid shape looks like")
    expect(third).toContain('"answer"')
  })

  test("gives up after three attempts with a descriptive reason", async () => {
    const { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>]),
     result = await spawnStructured(client, options)

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(3)
    expect(prompts.length).toBe(3)
    if (!result.ok) {
      expect(result.reason).toBe("schema-failed")
      expect(result.detail).toContain("after 3 attempts")
    }
  })

  test("locally re-validates: a structurally wrong value triggers a retry", async () => {
    // The host validates against the schema it was given, so a mismatch reaching here means the
    // value came back through a path that skipped that check — the compaction case.
    const { client, prompts } = makeClient([
      { info: { structured: { wrong: 1 } } } as Partial<PromptResponse>,
      { info: { structured: { answer: "ok" } } } as Partial<PromptResponse>,
    ]),
     result = await spawnStructured(client, options)

    expect(result.ok).toBe(true)
    expect(result.attempts).toBe(2)
    expect(prompts[1]?.body.parts[0]?.text).toContain("answer")
  })
})

describe("non-retryable outcomes", () => {
  test.each([
    ["MessageAbortedError", "aborted"],
    ["ContextOverflowError", "context-overflow"],
    ["ProviderAuthError", "api-error"],
  ] as const)("%s stops immediately rather than retrying", async (errorName, expectedReason) => {
    // Retrying an aborted run would fight the user; an auth failure or an exhausted context will
    // not improve by asking again.
    const { client, prompts } = makeClient([{ info: { error: { name: errorName } } } as Partial<PromptResponse>]),
     result = await spawnStructured(client, options)

    expect(result.ok).toBe(false)
    if (!result.ok) {expect(result.reason).toBe(expectedReason)}
    expect(prompts.length).toBe(1)
  })

  test("a failed session creation reports the real reason", async () => {
    const client = {
      session: {
        create: () => Promise.resolve({ error: { name: "BadRequest" } }),
        get: () => Promise.resolve({}),
        delete: () => Promise.resolve({}),
        abort: () => Promise.resolve({}),
        prompt: () => Promise.resolve({}),
      },
    } as unknown as OpencodeClient,

     result = await spawnStructured(client, options)
    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(0)
    if (!result.ok) {
      expect(result.reason).toBe("spawn-failed")
      expect(result.detail).toBe("BadRequest")
    }
  })

  test("a prompt transport failure is not retried as a schema miss", async () => {
    const { client, prompts } = makeClient(["no-data"]),
     result = await spawnStructured(client, options)

    expect(result.ok).toBe(false)
    if (!result.ok) {expect(result.reason).toBe("prompt-failed")}
    expect(prompts.length).toBe(1)
  })
})

describe("nudge construction", () => {
  test("handles a schema with no required list", async () => {
    const loose = { type: "object", properties: { a: { type: "string" } } },
     { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>])
    await spawnStructured(client, { ...options, schema: loose })

    const second = prompts[1]?.body.parts[0]?.text ?? ""
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
     { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>])
    await spawnStructured(client, { ...options, schema: complex })

    const third = prompts[2]?.body.parts[0]?.text ?? ""
    expect(third).toContain('"level": "high"')
    expect(third).toContain('"count": 0')
    expect(third).toContain('"flag": false')
    expect(third).toContain('"nothing": null')
  })

  test("handles an untyped schema without crashing", async () => {
    const { client, prompts } = makeClient([{ info: {} } as Partial<PromptResponse>])
    await spawnStructured(client, { ...options, schema: { required: ["x"] } })
    expect(prompts.length).toBe(3)
  })
})
