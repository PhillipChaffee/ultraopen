import type { LiveRunRecord, ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import { liveRunsForSession } from "../tool/background.js"
import { mentionsKeyword, requestsNoFanOut } from "./mode.js"
import {
  decorate,
  decorateLatest,
  renderRunsReminder,
  ULTRACODE_DEMOTED,
  ULTRACODE_ON,
} from "./reminders.js"
import type { LiveRunLine, RequestMessageLike } from "./reminders.js"
import { resolveEffort } from "../bridge/effort.js"

/**
 * The V2 hooks that turn ultracode on and keep it visible to the model.
 *
 * Three separate V2 hooks cooperate here, and each is used for exactly what it can do:
 *   - `ctx.session.hook("prompt")` sees the user's admitted text, so it detects the keyword. It
 *     stamps the message id on `event.metadata` so the ephemeral reminder's start point survives
 *     into the request messages.
 *   - `ctx.session.hook("context")` operates on request messages rebuilt for each model call, so
 *     anything it adds is ephemeral. That is where the reminders go.
 *   - `ctx.session.hook("experimental.model.resolve")` raises reasoning effort for one primary
 *     request without mutating the session's saved model.
 */

/** The structural subset of V2's `SessionPrompt` this module drives. */
export interface SessionPromptEventLike {
  readonly sessionID: string
  readonly messageID: string
  readonly prompt: { readonly text: string }
  metadata?: Record<string, unknown>
}

/** The structural subset of V2's `SessionContext` the reminder decorator drives. */
export interface SessionContextEventLike<Message extends RequestMessageLike> {
  readonly sessionID: string
  readonly agent?: string | undefined
  messages: Message[]
}

/** The structural subset of V2's `SessionModelResolve` this module drives. */
export interface ModelResolveEventLike {
  readonly sessionID: string
  readonly agent: string
  readonly kind: string
  model: { readonly providerID: string; readonly id: string; readonly variant?: string | undefined }
}

/** Resolves the reasoning variant for one model; absent when the model offers no suitable one. */
export type VariantResolver = (
  model: ModelResolveEventLike["model"],
) => string | undefined | Promise<string | undefined>

/**
 * Reacts to an admitted user turn: detects the keyword and any instruction to stop fanning out.
 *
 * Idempotent on the host message id. V2's `prompt` hook can fire more than once for the same
 * admitted message, and only the first firing may apply the turn's state transition.
 *
 * Returns `true` when this firing owned the message, `false` when it was a duplicate or an
 * engine-owned child.
 */
export function onSessionPrompt(
  event: SessionPromptEventLike,
  project: ProjectRuntime,
  coordinator: RuntimeCoordinator,
): boolean {
  // Engine-owned children are never put into ultracode: they are the fan-out, and telling them to
  // fan out again is how a run turns into a fork bomb.
  if (coordinator.owns(event.sessionID)) {return false}
  if (!project.mode.markProcessedMessage(event.sessionID, event.messageID)) {return false}

  // One-shot keyword turn boundary: a keyword fans out exactly the task that
  // said it, so when the NEXT user message arrives, what the keyword started is
  // finished. `/ultracode` and the plugin option are deliberately untouched.
  if (project.mode.getKeywordBehavior() === "one-shot") {project.mode.expireKeyword(event.sessionID)}

  const text = event.prompt.text
  if (requestsNoFanOut(text)) {
    project.mode.demote(event.sessionID)
  } else if (mentionsKeyword(text)) {
    // Only a source CHANGE re-enables. Re-mentioning the keyword while already active via the
    // keyword must not rewrite `fromMessageID`: the reminder is ephemeral and re-injected from
    // that message each turn, so moving it forward drops earlier messages' reminders and breaks
    // the byte-stable cache prefix. A negated mention ("don't use ultracode") demotes above and
    // never enables.
    const state = project.mode.stateOf(event.sessionID)
    if (!(state?.active && state.source === "keyword")) {
      project.mode.enable(event.sessionID, "keyword", event.messageID)
    }
  }

  // The reminder's start point rides the request message metadata. The AI SDK message id may be
  // absent, so the host message id is the durable correlator.
  event.metadata = { ...event.metadata, ultraopenMsgID: event.messageID }
  return true
}

/**
 * Appends the per-turn reminders to the request messages for one model call.
 *
 * Two decorations share this hook. The live-run reminder re-anchors any session holding live
 * background runs, independent of the ultracode mode; the ultracode reminder keeps the mode
 * visible. Both are ephemeral: the hook operates on request messages built for this call, so
 * nothing it adds is persisted.
 *
 * Returns the decorated message array, which the caller assigns back onto the event.
 */
export function onSessionContext<Message extends RequestMessageLike>(
  event: SessionContextEventLike<Message>,
  project: ProjectRuntime,
  coordinator: RuntimeCoordinator,
  options: { now?: (() => number) | undefined } = {},
): Message[] {
  // Children are the fan-out; a reminder there invites recursion.
  if (coordinator.owns(event.sessionID)) {return event.messages}

  // The live-run reminder FIRST and unconditionally of ultracode: a session that launched a
  // background run needs the anchor even when it never fanned out. Elapsed time and agent counts
  // read live state, so the text is computed per fire — decorateLatest replaces rather than
  // stacks, keeping exactly one reminder per turn.
  let messages = event.messages
  const live: readonly LiveRunRecord[] = liveRunsForSession(coordinator, event.sessionID)
  if (live.length > 0) {
    messages = decorateLatest(
      messages,
      renderRunsReminder(
        live.map((entry) => {
          const line: LiveRunLine = {
            runId: entry.runId,
            name: entry.name ?? entry.runId,
            agents: coordinator.sessionsOf(entry.runId).length,
            startedAt: entry.startedAt,
          }
          if (entry.title !== undefined) {line.title = entry.title}
          return line
        }),
        options.now?.() ?? Date.now(),
      ),
    )
  }

  if (!project.mode.isActive(event.sessionID, event.agent)) {return messages}

  // §1.6: an explicit instruction beats the mode. Effort stays raised; the standing opt-in does not.
  const demoted = project.mode.isDemoted(event.sessionID),
   state = project.mode.stateOf(event.sessionID)

  return decorate(messages, {
    text: demoted ? ULTRACODE_DEMOTED : ULTRACODE_ON,
    ...(state?.fromMessageID === undefined ? {} : { fromMessageID: state.fromMessageID }),
  })
}

/**
 * Raises reasoning effort for one primary request.
 *
 * V2 applies a mutated `event.model.variant` only to this request; the session keeps its saved
 * model, so the raise never leaks into later turns that no longer want it.
 */
export async function onModelResolve(
  event: ModelResolveEventLike,
  project: ProjectRuntime,
  coordinator: RuntimeCoordinator,
  resolveVariant: VariantResolver,
): Promise<boolean> {
  if (event.kind !== "primary") {return false}
  if (coordinator.owns(event.sessionID)) {return false}
  if (!project.mode.isActive(event.sessionID, event.agent)) {return false}

  const variant = await resolveVariant(event.model)
  if (variant === undefined || variant === "") {return false}
  event.model = { ...event.model, variant }
  return true
}

/** The default effort this plugin asks for when the mode is active. */
export const ULTRACODE_EFFORT = "xhigh"

/** Resolves `xhigh` against a model's real variant list, with the ladder's graceful downgrade. */
export function resolveUltracodeVariant(available: readonly string[]): string | undefined {
  return resolveEffort(ULTRACODE_EFFORT, { available }).variant
}
