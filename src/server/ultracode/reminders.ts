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
  return syntheticPart(message, text, `ultraopen-reminder-${messageID}-${seq}`)
}

function syntheticPart(message: MessageLike, text: string, id: string): TextPart {
  const messageID = message.info?.id ?? "unknown"
  return {
    id,
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

/**
 * The per-turn live-run reminder, shipped by ticket #9.
 *
 * While the launch registry holds a live background run for the session, this reminder re-anchors
 * the model each turn: the run exists, do not duplicate its work, the outcome arrives as a
 * notification. Unlike ULTRACODE_ON it is independent of the ultracode mode — any session that
 * launched a background run needs the anchor, whether or not it fans out.
 *
 * The template is FIXED-SHAPE: constant header lines, one line per run, constant closer. Only the
 * per-run line's fields vary. Shape stability keeps the tail of the prompt byte-stable between
 * steps of one turn, which is the little cache stability this decoration can afford (see
 * decorateLatest for the trade-off it accepts).
 */

/** Part-id prefix marking a live-run reminder, distinct from ULTRACODE's "ultraopen-reminder-". */
export const RUNS_REMINDER_PREFIX = "ultraopen-runs-"

/** One live background run as the reminder names it. */
export interface LiveRunLine {
  runId: string
  /** The workflow's meta name, or the run id when the launch had not parsed it yet. */
  name: string
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
      `- ${run.runId} "${run.name}" — ${run.agents} agents spawned so far, ` +
      `${formatElapsed(Math.max(0, now - run.startedAt))} elapsed`,
    ),
    "</system-reminder>",
  ].join("\n")
}

function isRunsReminder(part: unknown): boolean {
  if (typeof part !== "object" || part === null) {return false}
  const record = part as Record<string, unknown>
  return typeof record["id"] === "string" && record["id"].startsWith(RUNS_REMINDER_PREFIX)
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
export function decorateLatest(messages: MessageLike[], text: string): number {
  const last = messages.findLast((message) => message.info?.role === "user")
  if (!last || !Array.isArray(last.parts)) {return 0}
  last.parts = last.parts.filter((part) => !isRunsReminder(part))
  last.parts.push(syntheticPart(last, text, `${RUNS_REMINDER_PREFIX}${last.info?.id ?? "unknown"}`))
  return 1
}
