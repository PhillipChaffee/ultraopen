import { registry } from "../singleton.js"
import { mentionsKeyword, mode, requestsNoFanOut } from "./mode.js"
import { decorate, ULTRACODE_DEMOTED, ULTRACODE_ON, type MessageLike } from "./reminders.js"

/**
 * The hooks that turn ultracode on and keep it visible to the model.
 *
 * Three separate opencode hooks cooperate here, and each is used for exactly what it can do:
 *   - `chat.message` sees the user's text, so it detects the keyword. It must NOT write parts:
 *     those are persisted, and a reminder there would accumulate one copy per turn forever.
 *   - `experimental.chat.messages.transform` operates on messages re-read from the database each
 *     step, so anything it adds is ephemeral. That is where the reminder goes.
 *   - `chat.params` can raise reasoning effort for the parent turn itself.
 */

export type ChatMessageInput = {
  sessionID: string
  agent?: string
  messageID?: string
}

export type ChatMessageOutput = {
  message?: { id?: string; model?: { variant?: string | undefined } }
  parts?: Array<{ type?: string; text?: string }>
}

export type MessagesTransformOutput = {
  messages: MessageLike[]
}

/**
 * Reacts to a user turn: detects the keyword and any instruction to stop fanning out.
 *
 * Reads only. The one mutation it performs is on the message's own model variant, which the host
 * persists and later reads back — that is the supported way to raise effort for the parent turn.
 */
export function onChatMessage(
  input: ChatMessageInput,
  output: ChatMessageOutput,
  options: { resolveVariant?: ((effort: string) => string | undefined) | undefined } = {},
): void {
  // Engine-owned children are never put into ultracode: they are the fan-out, and telling them to
  // fan out again is how a run turns into a fork bomb.
  if (registry.owns(input.sessionID)) return

  const text = (output.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")

  if (requestsNoFanOut(text)) mode.demote(input.sessionID)

  if (mentionsKeyword(text)) {
    mode.enable(input.sessionID, "keyword", output.message?.id ?? input.messageID)
  }

  if (!mode.isActive(input.sessionID, input.agent)) return

  // Raise effort for the PARENT turn. The variant lives on the user message, which the host reads
  // back when building the request, so this is both effective and assertable afterwards.
  const variant = options.resolveVariant?.("xhigh")
  if (variant && output.message?.model) output.message.model.variant = variant
}

/**
 * Injects the per-turn reminder.
 *
 * The hook's input is an empty object, so the session and agent must be recovered from the
 * messages themselves.
 */
export function onMessagesTransform(output: MessagesTransformOutput, options: { compacting?: boolean } = {}): number {
  // Compaction runs this same hook over a clone that IS sent to the model. Decorating there would
  // put the fan-out instruction into the summarizer's prompt, where it means nothing.
  if (options.compacting === true) return 0

  const messages = output.messages
  if (!Array.isArray(messages) || messages.length === 0) return 0

  const sessionID = messages.at(-1)?.info?.sessionID
  if (!sessionID) return 0
  if (registry.owns(sessionID)) return 0

  const lastUser = messages.findLast((message) => message.info?.role === "user")
  const agentName = lastUser?.info?.agent

  if (!mode.isActive(sessionID, agentName)) return 0

  // §1.6: an explicit instruction beats the mode. Effort stays raised; the standing opt-in does not.
  const demoted = mode.isDemoted(sessionID)
  const state = mode.get(sessionID)

  return decorate(messages, {
    text: demoted ? ULTRACODE_DEMOTED : ULTRACODE_ON,
    fromMessageID: state?.fromMessageID,
  })
}

/**
 * Raises reasoning effort on the parent turn's provider options.
 *
 * Belt and braces alongside the user-message variant: the two paths are read at different points,
 * and a model whose variant map is unknown at message time can still be caught here.
 */
export function onChatParams(
  input: { sessionID?: string; agent?: string; model?: { variants?: Record<string, unknown> } },
  output: { options?: Record<string, unknown> },
  options: { resolveVariant?: ((effort: string, available: string[]) => string | undefined) | undefined } = {},
): void {
  if (!input.sessionID || registry.owns(input.sessionID)) return
  if (!mode.isActive(input.sessionID, input.agent)) return

  const available = input.model?.variants ? Object.keys(input.model.variants) : []
  const variant = options.resolveVariant?.("xhigh", available)
  if (!variant || !output.options) return

  // Merge rather than replace: the host has already assembled provider options by this point.
  const merged = input.model?.variants?.[variant]
  if (typeof merged === "object" && merged !== null) Object.assign(output.options, merged)
}
