import { describe, expect, test, beforeAll } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Upstream-shape pins for hydration (ticket #7), captured against the installed
 * opencode v1.18.31 (README-verified release). CI has no opencode checkout, so
 * the evidence is captured verbatim here instead of re-read at test time: these
 * literals ARE the upstream sources at capture time, and every claim our
 * citations make must be findable in them. When a citation is re-verified
 * against a new release, re-capture the excerpt with it.
 *
 * The second half reads our own types.ts and asserts the casts these facts
 * justify still exist — the "or unnecessary" clause of the drift-test contract:
 * a regenerated SDK that starts declaring these fields makes the cast removable.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..")

/** Capture: `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:70` (v1.18.31). */
const PROMPT_PAYLOAD_LINE = "export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, [\"sessionID\"]))"

/** Capture: `packages/opencode/src/session/prompt.ts:657` (v1.18.31) — messageID names the NEW message. */
const MESSAGE_ID_LINE = "id: input.messageID ?? MessageID.ascending(),"

/** Capture: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:311-329` (v1.18.31). */
const PROMPT_ASYNC_HANDLER = [
  "yield* requireSession(ctx.params.sessionID)",
  "yield* promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID }).pipe(",
  "Effect.forkIn(scope, { startImmediately: true }),",
  "return HttpApiSchema.NoContent.make()",
]

/** Capture: `packages/plugin/src/index.ts:224` (v1.18.31) — the plugin event hook's shape. */
const EVENT_HOOK_LINE = "event?: (input: { event: Event }) => Promise<void>"

/** Capture: `packages/schema/src/session-status-event.ts` (v1.18.31) — the idle event, deprecated but published. */
const IDLE_EVENT = [
  "// deprecated",
  "export const Idle = Event.define({",
  "  type: \"session.idle\",",
  "  schema: {",
  "    sessionID: SessionID,",
]

/** Capture: `packages/opencode/src/session/status.ts:42-43` (v1.18.31) — idle is still published. */
const IDLE_PUBLISH = [
  "if (status.type === \"idle\") {",
  "  yield* events.publish(Event.Idle, { sessionID })",
]

/** Capture: `packages/schema/src/v1/session.ts:556` (v1.18.31) — the session row keeps its agent. */
const SESSION_AGENT_LINE = "agent: optional(Schema.String),"

/** Capture: SDK `sdk.gen.d.ts:182-184` (installed 1.18.31) — the client exposes promptAsync. */
const SDK_PROMPT_ASYNC_LINE = "promptAsync<ThrowOnError extends boolean = false>(options: Options<SessionPromptAsyncData, ThrowOnError>)"
const SDK_PROMPT_ASYNC_URL = "url: \"/session/{id}/prompt_async\";"

/** Capture: SDK `types.gen.d.ts:2329-2347` (installed 1.18.31) — the gen body drifts from the route. */
const SDK_PROMPT_ASYNC_BODY = [
  "export type SessionPromptAsyncData = {",
  "    body?: {",
  "        messageID?: string;",
  "        agent?: string;",
  "        noReply?: boolean;",
  "        parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;",
]

/** Capture: SDK `types.gen.d.ts:2366-2371` — the async route answers 204, never a body. */
const SDK_PROMPT_ASYNC_RESPONSE = [
  "export type SessionPromptAsyncResponses = {",
  "    204: void;",
]

/** Capture: SDK `types.gen.d.ts:2234-2243` — the messages listing's response shape. */
const SDK_MESSAGES_RESPONSE = [
  "export type SessionMessagesResponses = {",
  "    200: Array<{",
  "        info: Message;",
  "        parts: Array<Part>;",
  "    }>;",
]

/** Capture: SDK `types.gen.d.ts:465-497` — the generated Session row omits `agent`. */
const SDK_SESSION_OMITS_AGENT = [
  "export type Session = {",
  "    id: string;",
  "    projectID: string;",
  "    directory: string;",
  "    parentID?: string;",
]

describe("captured upstream facts (opencode v1.18.31)", () => {
  test("the prompt_async route accepts the sync prompt's body minus sessionID", () => {
    expect(PROMPT_PAYLOAD_LINE).toContain("PromptInput.fields")
    expect(PROMPT_PAYLOAD_LINE).toContain("[\"sessionID\"]")
  })

  test("messageID names the new user message — it is not a requeue pointer", () => {
    expect(MESSAGE_ID_LINE).toContain("input.messageID ?? MessageID.ascending()")
  })

  test("prompt_async forks the same prompt service and answers 204 immediately", () => {
    expect(PROMPT_ASYNC_HANDLER.some((line) => line.includes("promptSvc.prompt"))).toBe(true)
    expect(PROMPT_ASYNC_HANDLER.some((line) => line.includes("Effect.forkIn"))).toBe(true)
    expect(PROMPT_ASYNC_HANDLER.some((line) => line.includes("NoContent"))).toBe(true)
  })

  test("the plugin event hook is a plain event listener", () => {
    expect(EVENT_HOOK_LINE).toContain("input: { event: Event }")
  })

  test("session.idle carries only the sessionID and is still published despite deprecation", () => {
    expect(IDLE_EVENT.join("\n")).toContain("type: \"session.idle\",")
    expect(IDLE_PUBLISH.join("\n")).toContain("events.publish(Event.Idle, { sessionID })")
  })

  test("the server's session row keeps `agent`; hydration must pass it explicitly", () => {
    expect(SESSION_AGENT_LINE).toContain("agent: optional(Schema.String)")
  })

  test("the SDK client exposes promptAsync against /session/{id}/prompt_async", () => {
    expect(SDK_PROMPT_ASYNC_LINE).toContain("promptAsync")
    expect(SDK_PROMPT_ASYNC_URL).toContain("/session/{id}/prompt_async")
  })

  test("the SDK's generated prompt_async body omits format and variant but keeps messageID — the cast is necessary", () => {
    const body = SDK_PROMPT_ASYNC_BODY.join("\n")
    expect(body).toContain("messageID?: string;")
    expect(body).not.toContain("format")
    expect(body).not.toContain("variant")
  })

  test("the async route answers 204 with no body", () => {
    expect(SDK_PROMPT_ASYNC_RESPONSE.join("\n")).toContain("204: void;")
  })

  test("the messages listing returns {info, parts} rows", () => {
    const response = SDK_MESSAGES_RESPONSE.join("\n")
    expect(response).toContain("info: Message;")
    expect(response).toContain("parts: Array<Part>;")
  })

  test("the generated Session row omits agent — the SessionInfo.agent cast is necessary", () => {
    expect(SDK_SESSION_OMITS_AGENT.join("\n")).not.toContain("agent")
  })
})

describe("our casts still exist and carry these citations", () => {
  let types = ""
  beforeAll(async () => {
    types = await readFile(join(REPO_ROOT, "src", "server", "types.ts"), "utf8")
  })

  test("OpencodeClient declares promptAsync and messages", () => {
    expect(types).toContain("promptAsync: (options: { path: { id: string }; body: PromptBody })")
    expect(types).toContain("messages: (options: { path: { id: string } })")
  })

  test("SessionInfo declares the agent field the SDK omits", () => {
    expect(types).toContain("agent?: string")
  })

  test("the PromptBody citation names the prompt_async route and the messageID semantics", () => {
    expect(types).toContain("groups/session.ts:70")
    expect(types).toContain("input.messageID ?? MessageID.ascending()")
  })

  test("the header's citation line names the verified release", () => {
    expect(types).toContain("opencode v1.18.31")
  })
})