/**
 * Pure normalizers between OpenCode V2 wire shapes and the {@link HostPort} domain.
 *
 * Nothing here touches a host: every function is a total projection of already-fetched data, so the
 * adapter stays a thin call-and-map layer and these branches are unit-testable on their own.
 */
import type {
  CreateChildSessionInput,
  HostAgentInfo,
  HostModelRef,
  HostPermissionRule,
  HostSessionInfo,
  HostTurnResult,
} from "./port.js"

/** The JSON subset the host accepts for session metadata. */
export interface V2JsonObject {
  readonly [key: string]: V2Json
}
export type V2Json = null | boolean | number | string | V2Json[] | V2JsonObject
export type V2JsonRecord = Readonly<Record<string, V2Json>>

export interface V2PermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
}

export interface V2ModelInfo {
  readonly id: string
  readonly providerID: string
  readonly variants: readonly { readonly id: string }[]
}

export interface V2ModelSelection {
  readonly id: string
  readonly providerID: string
  readonly variant?: string
}

export interface V2SessionInfo {
  readonly id: string
  readonly parentID?: string | undefined
  readonly projectID: string
  readonly agent?: string | undefined
  readonly model?: V2ModelSelection | undefined
  readonly permissions?: readonly V2PermissionRule[] | undefined
  readonly metadata?: V2JsonRecord | undefined
  readonly tokens: { readonly output: number }
  readonly location: { readonly directory: string }
  readonly outcome?: "succeeded" | "failed" | "interrupted" | undefined
}

export interface V2SessionMessage {
  readonly id: string
  readonly type: string
  readonly status?: string | undefined
  readonly outcome?: "succeeded" | "failed" | "interrupted" | undefined
  readonly error?: { readonly type: string; readonly message: string } | undefined
  readonly tokens?: { readonly output: number } | undefined
  readonly text?: string | undefined
  readonly content?: readonly { readonly type: string; readonly text?: string | undefined }[] | undefined
}

export interface V2AgentInfo {
  readonly id: string
  readonly mode: "primary" | "subagent" | "all"
  readonly hidden: boolean
  readonly permissions: readonly V2PermissionRule[]
}

export interface V2PermissionRequest {
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
}

export interface V2CreateSessionInput {
  readonly title?: string | null | undefined
  readonly agent?: string | null | undefined
  readonly model?: V2ModelSelection | null | undefined
  readonly location?: { readonly directory: string } | null | undefined
  readonly metadata?: V2JsonRecord | null | undefined
  readonly permissions?: readonly V2PermissionRule[] | null | undefined
}

export interface V2PromptInput {
  readonly sessionID: string
  readonly id?: string | null | undefined
  readonly text: string
  readonly delivery?: "steer" | "queue" | null | undefined
}

export interface V2SyntheticInput {
  readonly sessionID: string
  readonly id?: string | null | undefined
  readonly text: string
  readonly description?: string | null | undefined
  readonly metadata?: V2JsonRecord | undefined
  readonly delivery?: "steer" | "queue" | null | undefined
  readonly resume?: boolean | null | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isTurnOutcome(value: unknown): value is HostTurnResult["outcome"] {
  return value === "succeeded" || value === "failed" || value === "interrupted"
}

/** Extracts a human-readable detail from any thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) {return error.message}
  if (typeof error === "string") {return error}
  if (isRecord(error)) {
    const message = error["message"]
    if (typeof message === "string") {return message}
  }
  return String(error)
}

/** Ultraopen metadata is JSON by construction; the domain type stays `unknown` on purpose. */
export function toJsonRecord(value: Record<string, unknown>): V2JsonRecord {
  return value as unknown as V2JsonRecord
}

export function toHostModelRef(model: V2ModelSelection): HostModelRef {
  return model.variant === undefined
    ? { providerID: model.providerID, modelID: model.id }
    : { providerID: model.providerID, modelID: model.id, variant: model.variant }
}

export function toV2ModelSelection(model: HostModelRef): V2ModelSelection {
  return model.variant === undefined
    ? { id: model.modelID, providerID: model.providerID }
    : { id: model.modelID, providerID: model.providerID, variant: model.variant }
}

export function toHostPermissionRule(rule: V2PermissionRule): HostPermissionRule {
  return { action: rule.action, resource: rule.resource, effect: rule.effect }
}

function toV2PermissionRule(rule: HostPermissionRule): V2PermissionRule {
  return { action: rule.action, resource: rule.resource, effect: rule.effect }
}

export function toHostSessionInfo(info: V2SessionInfo): HostSessionInfo {
  return {
    id: info.id,
    projectID: info.projectID,
    directory: info.location.directory,
    outputTokens: info.tokens.output,
    ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
    ...(info.agent === undefined ? {} : { agent: info.agent }),
    ...(info.model === undefined ? {} : { model: toHostModelRef(info.model) }),
    ...(info.permissions === undefined
      ? {}
      : { permissions: info.permissions.map((rule) => toHostPermissionRule(rule)) }),
    ...(info.metadata === undefined ? {} : { metadata: info.metadata }),
  }
}

export function toHostAgentInfo(agent: V2AgentInfo): HostAgentInfo {
  return {
    id: agent.id,
    mode: agent.mode,
    hidden: agent.hidden,
    permissions: agent.permissions.map((rule) => toHostPermissionRule(rule)),
  }
}

export function toCreateInput(input: CreateChildSessionInput): V2CreateSessionInput {
  // No `parentID` key is ever constructed: workflow children stay unparented on purpose.
  return {
    title: input.title,
    metadata: toJsonRecord(input.metadata),
    ...(input.agent === undefined ? {} : { agent: input.agent }),
    ...(input.model === undefined ? {} : { model: toV2ModelSelection(input.model) }),
    ...(input.location === undefined ? {} : { location: { directory: input.location } }),
    ...(input.permissions === undefined
      ? {}
      : { permissions: input.permissions.map((rule) => toV2PermissionRule(rule)) }),
  }
}

export interface TurnSlice {
  readonly messages: readonly V2SessionMessage[]
  readonly afterCompaction: boolean
}

/**
 * Selects the messages belonging to one turn.
 *
 * Everything at or before `messageID` is stale. If a compaction hid that ID, the tail after the
 * latest completed compaction is the only comparable window, and callers must use the session's
 * cumulative token delta instead of summing the visible steps.
 */
export function sliceTurn(messages: readonly V2SessionMessage[], messageID: string): TurnSlice {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index !== -1) {return { messages: messages.slice(index + 1), afterCompaction: false }}
  for (let cursor = messages.length - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]
    if (message?.type === "compaction" && message.status === "completed") {
      return { messages: messages.slice(cursor + 1), afterCompaction: true }
    }
  }
  return { messages, afterCompaction: false }
}

export function sumOutputTokens(messages: readonly V2SessionMessage[]): number {
  let total = 0
  for (const message of messages) {
    if (message.type === "assistant" && message.tokens !== undefined) {total += message.tokens.output}
  }
  return total
}

export function lastAssistantText(messages: readonly V2SessionMessage[]): string {
  let text = ""
  for (const message of messages) {
    if (message.type !== "assistant") {continue}
    for (const part of message.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {text = part.text}
    }
  }
  return text
}

export function lastIdle(messages: readonly V2SessionMessage[]): V2SessionMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type === "idle") {return message}
  }
  return undefined
}

export function lastTurnError(
  messages: readonly V2SessionMessage[],
): { type: string; message: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const error = messages[index]?.error
    if (error !== undefined) {return { type: error.type, message: error.message }}
  }
  return undefined
}

/** Maps a failed synthetic admission onto the port's stable outcomes. */
export function admissionFailure(error: unknown): "session-missing" | "conflict" | "error" {
  const record = isRecord(error) ? error : undefined
  const tags: string[] = []
  for (const key of ["_tag", "name", "code", "type"]) {
    const value = record?.[key]
    if (typeof value === "string") {tags.push(value.toLowerCase())}
  }
  const tag = tags.join(" ")
  if (tag.includes("notfound") || tag.includes("not_found") || tag.includes("not found")) {
    return "session-missing"
  }
  if (tag.includes("conflict")) {return "conflict"}
  const status = record?.["status"] ?? record?.["statusCode"]
  if (status === 404) {return "session-missing"}
  if (status === 409) {return "conflict"}
  return "error"
}
