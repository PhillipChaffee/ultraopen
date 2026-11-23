import { oneLineText } from "../tool/render.js"

/**
 * The per-turn ultracode reminder, for OpenCode V2 request messages.
 *
 * Injected through `ctx.session.hook("context")`, which mutates the request messages built for one
 * model call. Those messages are re-read and rebuilt each step and are NOT persisted, so a
 * reminder appended here is EPHEMERAL. The V1 alternative — writing onto `chat.message`'s parts —
 * accumulated one copy per user turn forever.
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

When a workflow call returns at once with a run id, that run is executing in the background — its
outcome arrives as a <workflow-completed> or <workflow-failed> notification, so never duplicate
or re-launch its work, and read its progress with workflow_status instead of waiting on it.

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

/** Marker used to detect an already-decorated message, so the hook is idempotent. */
export const REMINDER_MARKER = "Ultracode is on:"

/** One text part of an AI SDK request message. */
export interface RequestContentPart {
  readonly type: string
  readonly text?: string | null | undefined
}

/**
 * The structural subset of `AI.SessionRequestMessage` the reminder cares about.
 *
 * `metadata` is the STORED session message's metadata, carried through by V2 for reading only.
 * `metadata.ultraopenMsgID` is the host message id the prompt hook stamped, and it is what makes
 * the reminder's start point survive the AI SDK's own `id` being absent.
 */
export interface RequestMessageLike {
  readonly id?: string | undefined
  readonly role?: string | undefined
  readonly content?: readonly RequestContentPart[] | undefined
  readonly metadata?: Readonly<Record<string, unknown>> | undefined
}

/** A synthetic reminder part — a plain text content part in the V2 request shape. */
export interface ReminderPart {
  readonly type: "text"
  readonly text: string
}

/**
 * Decorates every user message at or after the toggle point.
 *
 * Not just the last one, for two reasons. It is what makes the spec's symmetric off-signal
 * expressible — the model can see when the mode changed mid-conversation — and it keeps the cache
 * prefix byte-stable, since a last-message-only reminder moves every turn and re-pays the whole
 * prefix.
 *
 * Returns a NEW messages array: V2 request messages are readonly, so the hook replaces what it
 * needs instead of mutating in place.
 */
export function decorate<T extends RequestMessageLike>(
  messages: readonly T[],
  options: { text: string; fromMessageID?: string | undefined },
): T[] {
  let reached = options.fromMessageID === undefined
  return messages.map((message) => {
    if (message.role !== "user") {return message}
    if (!reached) {
      if (messageIDOf(message) !== options.fromMessageID) {return message}
      reached = true
    }
    const content = message.content ?? []
    // Idempotent: the hook can fire more than once per turn, and duplicate reminders would both
    // waste context and break the cache prefix.
    if (content.some((part) => isUltracodeReminder(part))) {return message}
    return { ...message, content: [...content, reminderPart(options.text)] }
  })
}

/** The host message id a request message carries, from metadata first and the AI SDK id second. */
export function messageIDOf(message: RequestMessageLike): string | undefined {
  const stamped = message.metadata?.["ultraopenMsgID"]
  if (typeof stamped === "string") {return stamped}
  return message.id
}

function reminderPart(text: string): ReminderPart {
  return { type: "text", text }
}

function isUltracodeReminder(part: RequestContentPart): boolean {
  return part.type === "text" && (part.text === ULTRACODE_ON || part.text === ULTRACODE_DEMOTED)
}

/**
 * The per-turn live-run reminder, shipped by ticket #9.
 *
 * While the coordinator holds a live background run for the session, this reminder re-anchors the
 * model each turn: the run exists, do not duplicate its work, the outcome arrives as a
 * notification. Unlike ULTRACODE_ON it is independent of the ultracode mode — any session that
 * launched a background run needs the anchor, whether or not it fans out.
 *
 * The template is FIXED-SHAPE: constant header lines, one line per run, constant closer. Only the
 * per-run line's fields vary. Shape stability keeps the tail of the prompt byte-stable between
 * steps of one turn, which is the little cache stability this decoration can afford (see
 * decorateLatest for the trade-off it accepts).
 */

/** The fixed header line that marks a live-run reminder part, distinct from ULTRACODE's text. */
export const RUNS_REMINDER_PREFIX = "<system-reminder>\nBackground workflow runs are live"

/** One live background run as the reminder names it. */
export interface LiveRunLine {
  runId: string
  /** The workflow's meta name, or the run id when the launch had not parsed it yet. */
  name: string
  /**
   * The launch's `title` metadata (#142), when the launch passed one; the line shows it as a
   * parenthetical beside the quoted name — the name stays primary. Absent on untitled runs.
   */
  title?: string
  /** Agents the run has spawned so far — live children registered under the run. */
  agents: number
  /** Epoch ms the run was registered at; elapsed is computed against `now`. */
  startedAt: number
}

/** Rounds an elapsed span down to seconds, then minutes, then h+mm — fixed shape per unit. */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) {return `${Math.floor(ms / 1000)}s`}
  if (ms < 3_600_000) {return `${Math.floor(ms / 60_000)}m`}
  const hours = Math.floor(ms / 3_600_000),
   minutes = Math.floor((ms % 3_600_000) / 60_000)
  return `${hours}h${String(minutes).padStart(2, "0")}m`
}

/**
 * Renders the live-run reminder for one turn.
 *
 * Header, one line per run, closer — nothing else, so the shape never varies with run count. The
 * "don't duplicate its work" phrasing mirrors the launch handle's contract sentence so the two
 * surfaces teach the same discipline.
 */
export function renderRunsReminder(runs: readonly LiveRunLine[], now: number): string {
  return [
    "<system-reminder>",
    "Background workflow runs are live in this session. Do not duplicate their work — avoid the files",
    "and topics they are using; each run's outcome arrives as a <workflow-completed> or <workflow-failed>",
    "notification, and workflow_status reads its progress on demand.",
    ...runs.map((run) =>
      `- ${run.runId} "${run.name}"${run.title === undefined ? "" : ` (${oneLineText(run.title)})`} — ` +
      `${run.agents} agents spawned so far, ` +
      `${formatElapsed(Math.max(0, now - run.startedAt))} elapsed`,
    ),
    "</system-reminder>",
  ].join("\n")
}

function isRunsReminder(part: RequestContentPart): boolean {
  return part.type === "text" && typeof part.text === "string" && part.text.startsWith(RUNS_REMINDER_PREFIX)
}

/**
 * Decorates ONLY the latest user message — the deliberate opposite of decorate()'s
 * every-message-from-the-toggle-point rule.
 *
 * decorate() decorates forward from the toggle point to keep the cache prefix byte-stable; this
 * reminder cannot follow that rule because its CONTENT changes (elapsed time grows, runs come and
 * go). The accepted trade-off: the reminder is brief and rides the END of the prompt, so the
 * prefix before the latest message stays warm and only the tail past the newest user text is
 * re-paid. Refires REPLACE the part rather than stacking a second copy — the hook can fire more
 * than once per turn, and each fire must leave exactly one reminder carrying the freshest elapsed
 * time.
 */
export function decorateLatest<T extends RequestMessageLike>(messages: readonly T[], text: string): T[] {
  const lastIndex = messages.findLastIndex((message) => message.role === "user")
  if (lastIndex === -1) {return [...messages]}
  return messages.map((message, index) => {
    if (index !== lastIndex) {return message}
    const kept = (message.content ?? []).filter((part) => !isRunsReminder(part))
    return { ...message, content: [...kept, reminderPart(text)] }
  })
}
