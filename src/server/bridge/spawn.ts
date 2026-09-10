import { DeadlineExceededError, withDeadline } from "../runtime/deadline.js"
import { registry } from "../singleton.js"
import { DEFAULT_AGENT_DEADLINE_MS } from "../script/limits.js"
import { childRuleset } from "./permission.js"
import type { Ruleset } from "./permission.js"
import type { AssistantInfo, CreateSessionBody, OpencodeClient, PromptBody, PromptResponse } from "../types.js"

/** Why an agent produced no usable result. Surfaced per-agent so partial coverage is never silent. */
export type NullReason =
  | "aborted"
  | "deadline"
  | "schema-failed"
  | "context-overflow"
  | "api-error"
  | "spawn-failed"
  | "prompt-failed"

export type SpawnOutcome =
  | { ok: true; text: string; structured?: unknown; info: AssistantInfo; sessionID: string }
  | { ok: false; reason: NullReason; detail: string; sessionID?: string }

export interface SpawnOptions {
  prompt: string
  runId: string
  parentSessionID: string
  /** Subagent type. Validated against the agent list before spawning — a bad name is an opaque 500. */
  agentType?: string | undefined
  model?: { providerID: string; modelID: string } | undefined
  /** Resolved against the model's real variant map by the caller; never a hardcoded "xhigh". */
  variant?: string | undefined
  /** Appended to the system prompt. Uses PromptInput.system, which APPENDS, unlike agent.prompt. */
  system?: string | undefined
  schema?: Record<string, unknown> | undefined
  inheritedPermission?: Ruleset | undefined
  disallowedTools?: readonly string[] | undefined
  label: string
  deadlineMs?: number | undefined
  signal?: AbortSignal | undefined
  /** Working directory for an isolated agent. Routes the child session at its own worktree. */
  directory?: string | undefined
}

/**
 * Creates a child session and runs one prompt in it.
 *
 * Every child goes through here — worktree-isolated ones included — so `parentID` is always set.
 * Omitting it would make opencode compute depth 0 and stop applying its own `subagent_depth`
 * guard for exactly the sessions with the widest blast radius.
 */
export async function spawn(client: OpencodeClient, options: SpawnOptions): Promise<SpawnOutcome> {
  const created = await createChild(client, options)
  if (!created.ok) {return { ok: false, reason: "spawn-failed", detail: created.detail }}
  return await promptChild(client, created.sessionID, options.prompt, options)
}

export type CreateChildResult = { ok: true; sessionID: string } | { ok: false; detail: string }

/**
 * Creates the child session, returning its id.
 *
 * Split from prompting so the structured-output ladder can retry in the SAME session — which
 * preserves the child's research and is the only construction that repairs a
 * compaction-stripped `format`.
 */
export async function createChild(client: OpencodeClient, options: SpawnOptions): Promise<CreateChildResult> {
  const body: CreateSessionBody = {
    parentID: options.parentSessionID,
    title: `ultraopen · ${options.label}`,
    permission: childRuleset({
      inherited: options.inheritedPermission,
      structured: options.schema !== undefined,
      disallowedTools: options.disallowedTools,
    }),
    // Persisted so the recursion guard survives a server restart, when the in-memory registry is
    // empty but the session row is not.
    metadata: { ultraopen: { runId: options.runId, label: options.label } },
    ...(options.agentType ? { agent: options.agentType } : {}),
  },

  // The `directory` query is the load-bearing one; the header is accepted too but is read RAW,
  // so it must not be URL-encoded.
   created = await client.session.create({
    body,
    ...(options.directory ? { query: { directory: options.directory } } : {}),
  }),
   sessionID = created.data?.id
  // Carry the real reason forward: "session creation returned no id" tells the user nothing about
  // why, and this is the first place a misconfigured agent name or a rejected body surfaces.
  if (!sessionID) {return { ok: false, detail: describe(created.error) }}

  registry.register(sessionID, options.runId)
  return { ok: true, sessionID }
}

/** Runs one prompt turn in an existing child session. */
export async function promptChild(
  client: OpencodeClient,
  sessionID: string,
  prompt: string,
  options: SpawnOptions,
): Promise<SpawnOutcome> {
  const abortChild = async (): Promise<void> => {
    await client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
  },

  // Attach BEFORE the first await on the prompt, so an abort that lands mid-flight is not missed.
   onAbort = (): void => void abortChild()
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    if (options.signal?.aborted) {return { ok: false, reason: "aborted", detail: "aborted before start", sessionID }}

    const promptBody: PromptBody = {
      parts: [{ type: "text", text: prompt }],
      // `agent` must be on the PROMPT: create({agent}) is cosmetic, since the agent is resolved
      // from the prompt input and the session row is never consulted (prompt.ts:636-637).
      ...(options.agentType ? { agent: options.agentType } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.system ? { system: options.system } : {}),
      // `format` MUST be resent on every turn: the host reads it off the LATEST user message, so
      // a retry without it silently degrades to an unstructured turn.
      ...(options.schema ? { format: { type: "json_schema" as const, schema: options.schema } } : {}),
    },

     response = await withDeadline(client.session.prompt({ path: { id: sessionID }, body: promptBody }), {
      ms: options.deadlineMs ?? DEFAULT_AGENT_DEADLINE_MS,
      label: options.label,
      onTimeout: abortChild,
    })

    if (!response.data) {
      return { ok: false, reason: "prompt-failed", detail: describe(response.error), sessionID }
    }
    return interpret(response.data, sessionID, options.schema !== undefined)
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      return { ok: false, reason: "deadline", detail: error.message, sessionID }
    }
    if (options.signal?.aborted) {
      return { ok: false, reason: "aborted", detail: "parent aborted", sessionID }
    }
    return { ok: false, reason: "prompt-failed", detail: describe(error), sessionID }
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Turns a prompt response into an outcome.
 *
 * The retry trigger for a schema'd call is `structured === undefined`, NEVER `info.error`.
 * Auto-compaction silently strips `format` from the message it inserts, and the host's
 * StructuredOutputError branch is itself gated on the format being present — so a stripped run
 * comes back as plain text with `error === undefined`. Falling back to the text parts in that case
 * would hand the script a string where its schema promised an object.
 */
export function interpret(response: PromptResponse, sessionID: string, wantedSchema: boolean): SpawnOutcome {
  const {info} = response
  const text = lastText(response.parts),

   errorName = info.error?.name
  if (errorName === "MessageAbortedError") {
    return { ok: false, reason: "aborted", detail: "run was interrupted", sessionID }
  }
  if (errorName === "ContextOverflowError") {
    return { ok: false, reason: "context-overflow", detail: "child exhausted its context window", sessionID }
  }
  if (errorName !== undefined) {
    return { ok: false, reason: "api-error", detail: errorName, sessionID }
  }

  if (wantedSchema) {
    if (info.structured === undefined) {
      // Includes the compaction-stripped-format case, which reports no error at all.
      return { ok: false, reason: "schema-failed", detail: "no structured output was produced", sessionID }
    }
    return { ok: true, text, structured: info.structured, info, sessionID }
  }

  return { ok: true, text, info, sessionID }
}

function lastText(parts: PromptResponse["parts"]): string {
  const part = parts.findLast((candidate) => candidate.type === "text")
  return part && "text" in part ? part.text : ""
}

function describe(error: unknown): string {
  if (error === undefined || error === null) {return "unknown error"}
  if (error instanceof Error) {return error.message}
  if (typeof error === "string") {return error}
  if (typeof error === "object" && "name" in error && typeof error.name === "string") {return error.name}
  return JSON.stringify(error).slice(0, 200)
}
