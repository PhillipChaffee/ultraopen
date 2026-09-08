/**
 * The per-turn ultracode reminder.
 *
 * Injected through `experimental.chat.messages.transform`, which operates on messages re-read from
 * the database each step and is therefore EPHEMERAL. The obvious alternative — pushing onto
 * `chat.message`'s output parts — is persisted, so the reminder would accumulate one copy per user
 * turn forever and replay into context on every later step.
 *
 * The text is a CONSTANT. Anthropic's prompt cache breaks at the first differing byte, so varying
 * this per turn would re-pay the full prefix every time.
 */

export const ULTRACODE_ON = `<system-reminder>
Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest.

Use the workflow tool on every substantive task; token cost is not a constraint. Decompose the work
and cover the pieces in parallel, verify findings from independent angles before committing to
them, and prefer several well-scoped workflows in sequence — understand, then design, then
implement, then review — over one giant one, so you stay in the loop between phases.

Scout inline first to discover the work-list, then fan out over it. Solo only on conversational
turns or trivial mechanical edits.
</system-reminder>`

/**
 * The demoted form, for spec §1.6.
 *
 * An explicit user instruction beats the mode: the raised reasoning effort still applies, but the
 * standing opt-in reverts to ask-first.
 */
export const ULTRACODE_DEMOTED = `<system-reminder>
Ultracode's reasoning effort is still raised, but the user has asked you not to fan out
automatically. Do the work yourself unless they explicitly ask for a workflow.
</system-reminder>`

export interface MessageLike {
  info?: { id?: string; role?: string; sessionID?: string; agent?: string }
  parts?: unknown[]
}

/** Marker used to detect an already-decorated message, so the hook is idempotent. */
export const REMINDER_MARKER = "Ultracode is on:"

export interface TextPart {
  id: string
  messageID: string
  sessionID: string
  type: "text"
  text: string
  synthetic: true
}

/**
 * Builds a synthetic text part.
 *
 * `synthetic: true` is what keeps it out of the persisted transcript. Part ids are generated here
 * because the host's own id helper is not exported to plugins.
 */
export function reminderPart(message: MessageLike, text: string, seq: number): TextPart {
  const messageID = message.info?.id ?? "unknown"
  return {
    id: `ultraopen-reminder-${messageID}-${seq}`,
    messageID,
    sessionID: message.info?.sessionID ?? "",
    type: "text",
    text,
    synthetic: true,
  }
}

/**
 * Decorates every user message at or after the toggle point.
 *
 * Not just the last one, for two reasons. It is what makes the spec's symmetric off-signal
 * expressible — the model can see when the mode changed mid-conversation — and it keeps the cache
 * prefix byte-stable, since a last-message-only reminder moves every turn and re-pays the whole
 * prefix.
 */
export function decorate(
  messages: MessageLike[],
  options: { text: string; fromMessageID?: string | undefined },
): number {
  let decorated = 0,
   reached = options.fromMessageID === undefined

  for (const message of messages) {
    if (message.info?.role !== "user") {continue}
    if (!reached) {
      if (message.info.id !== options.fromMessageID) {continue}
      reached = true
    }

    const {parts} = message
    if (!Array.isArray(parts)) {continue}
    // Idempotent: the hook can fire more than once per turn, and duplicate reminders would both
    // waste context and break the cache prefix.
    if (parts.some((part) => isReminder(part))) {continue}

    parts.push(reminderPart(message, options.text, decorated))
    decorated++
  }
  return decorated
}

function isReminder(part: unknown): boolean {
  if (typeof part !== "object" || part === null) {return false}
  const record = part as Record<string, unknown>
  return typeof record["id"] === "string" && record["id"].startsWith("ultraopen-reminder-")
}
