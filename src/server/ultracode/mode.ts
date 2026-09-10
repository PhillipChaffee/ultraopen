/**
 * Per-session ultracode state.
 *
 * Plugin-owned rather than stored on the session row. `session.agent` looks like the natural home,
 * but the TUI keeps the agent chip in a client-local store and sends it on every submit, so the
 * host reverts the row on the next plain turn — a mode stored there would silently switch itself
 * off after one message.
 */

export type ModeSource = "agent" | "keyword" | "command" | "option"

export interface ModeState {
  active: boolean
  source: ModeSource
  /** Message id at which the mode was switched on, so earlier turns are not retroactively decorated. */
  fromMessageID?: string | undefined
}

const sessions = new Map<string, ModeState>(),

/**
 * Sessions where the user has told the agent NOT to fan out.
 *
 * Spec §1.6: an explicit instruction beats the mode. Ultracode's raised reasoning effort still
 * applies, but the standing opt-in reverts to ask-first.
 */
 demoted = new Set<string>()

/**
 * Project-level default, from the plugin-options tuple.
 *
 * Applied per session on first sight rather than globally, so a later `/ultracode off` in one
 * session does not leak into another.
 */
let defaultOn = false

export const mode = {
  /** Sets the project-level default from plugin options. */
  setDefault(active: boolean): void {
    defaultOn = active
  },

  /** Turns the mode on for a session. Later sources overwrite earlier ones. */
  enable(sessionID: string, source: ModeSource, fromMessageID?: string): void {
    // An explicit re-enable is a later instruction than an earlier "don't fan out", and wins.
    demoted.delete(sessionID)
    sessions.set(sessionID, { active: true, source, fromMessageID })
  },

  disable(sessionID: string): void {
    sessions.set(sessionID, { active: false, source: "command" })
  },

  get(sessionID: string): ModeState | undefined {
    return sessions.get(sessionID)
  },

  /**
   * Whether ultracode is on for this turn.
   *
   * An explicit toggle in this session wins over everything — including the `ultracode` agent
   * itself. Selecting the `ultracode` primary agent is the signal when no toggle exists, and
   * needs no state at all; but once the user has run `/ultracode off`, that command must beat
   * the agent they happen to be sitting on.
   */
  isActive(sessionID: string, agentName?: string): boolean {
    const state = sessions.get(sessionID)
    if (state) {return state.active}
    if (agentName === "ultracode") {return true}
    return defaultOn
  },

  /** Records that the user asked for no automatic fan-out in this session. */
  demote(sessionID: string): void {
    demoted.add(sessionID)
  },

  isDemoted(sessionID: string): boolean {
    return demoted.has(sessionID)
  },

  resetForTests(): void {
    sessions.clear()
    demoted.clear()
    defaultOn = false
  },
}

/**
 * Detects the one-shot keyword.
 *
 * Word-boundary matched, so "ultracoded" does not trigger it. A path like `src/ultracode.ts` DOES
 * — `/` and `.` are word boundaries — and that is left alone deliberately: it matches the upstream
 * behaviour, the cost is a single turn at higher effort, and it is visible rather than silent.
 * Trying to exclude filenames would mean guessing at intent, and a false NEGATIVE (the keyword
 * quietly doing nothing) is the worse failure.
 */
export function mentionsKeyword(text: string): boolean {
  return /\bultracode\b/iu.test(text)
}

/**
 * Detects an explicit instruction to stop fanning out.
 *
 * Deliberately narrow. A false positive silently disables the feature the user turned on, which is
 * worse than missing a phrasing — so this matches only unambiguous negations rather than trying to
 * infer intent.
 */
export function requestsNoFanOut(text: string): boolean {
  return /\b(?:no|stop|don'?t|do not|avoid|without)\b[^.!?\n]{0,40}\b(?:workflows?|fan[- ]?out|subagents?|parallel agents?|ultracode)\b/iu.test(
    text,
  )
}
