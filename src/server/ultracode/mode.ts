/**
 * Per-project ultracode state.
 *
 * Each {@link ProjectMode} is instantiated by the process-wide coordinator, one per project,
 * so two projects in one server never see each other's toggles. A plugin-owned store rather
 * than a session-row field: `session.agent` looks like the natural home, but the TUI keeps the
 * agent chip in a client-local store and sends it on every submit, so the host reverts the row
 * on the next plain turn — a mode stored there would silently switch itself off after one
 * message.
 */

export type ModeSource = "agent" | "keyword" | "command" | "option"

export interface ModeState {
  active: boolean
  source: ModeSource
  /** Message id at which the mode was switched on, so earlier turns are not retroactively decorated. */
  fromMessageID?: string | undefined
}

/**
 * How a keyword mention behaves, from the plugin-options tuple.
 *
 * `one-shot` (the default) fans out exactly the task that mentioned the keyword;
 * the next task behaves normally unless the keyword is said again. `session`
 * reproduces the old sticky behaviour, where one mention raised the spend of
 * every later message in silence — kept for anyone who prefers it.
 */
export type KeywordBehavior = "one-shot" | "session"

/** The ultracode state owned by ONE project. Every member is independent of every other project. */
export interface ProjectMode {
  /** Sets the project-level default from plugin options. */
  readonly setDefault: (active: boolean) => void

  /** Sets the keyword behaviour from plugin options. */
  readonly setKeywordBehavior: (behavior: KeywordBehavior) => void

  readonly getKeywordBehavior: () => KeywordBehavior

  /**
   * Ends a keyword turn.
   *
   * Removes keyword-sourced state so the NEXT task behaves normally. `/ultracode`
   * and the plugin option are deliberately untouched: the one-shot applies only
   * to what the keyword itself started.
   */
  readonly expireKeyword: (sessionID: string) => void

  /** Turns the mode on for a session. Later sources overwrite earlier ones. */
  readonly enable: (sessionID: string, source: ModeSource, fromMessageID?: string) => void

  readonly disable: (sessionID: string) => void

  /** This session's stored state, or undefined when it has never been toggled. */
  readonly stateOf: (sessionID: string) => ModeState | undefined

  /**
   * Whether ultracode is on for this turn.
   *
   * An explicit toggle in this session wins over everything — including the `ultracode` agent
   * itself. Selecting the `ultracode` primary agent is the signal when no toggle exists, and
   * needs no state at all; but once the user has run `/ultracode off`, that command must beat
   * the agent they happen to be sitting on.
   */
  readonly isActive: (sessionID: string, agentName?: string) => boolean

  /** Records that the user asked for no automatic fan-out in this session. */
  readonly demote: (sessionID: string) => void

  readonly isDemoted: (sessionID: string) => boolean

  /**
   * Claims one admitted message for processing.
   *
   * V2's `prompt` hook can fire more than once for the same admitted message. Returns `true`
   * exactly once per `(sessionID, messageID)`, so the retry reads as already processed and
   * never applies the turn's state transition twice.
   */
  readonly markProcessedMessage: (sessionID: string, messageID: string) => boolean

  /** Restores a clean mode: no sessions, no demotions, no processed ids, option defaults reset. */
  readonly reset: () => void
}

/** Creates the mode state for one project. The coordinator holds exactly one per project key. */
export function createProjectMode(): ProjectMode {
  const sessions = new Map<string, ModeState>(),
    /**
     * Sessions where the user has told the agent NOT to fan out.
     *
     * Spec §1.6: an explicit instruction beats the mode. Ultracode's raised reasoning effort still
     * applies, but the standing opt-in reverts to ask-first.
     */
    demoted = new Set<string>(),
    /** Session id -> admitted message ids this project already acted on. */
    processed = new Map<string, Set<string>>()

  /**
   * Project-level default, from the plugin-options tuple.
   *
   * Applied per session on first sight rather than globally, so a later `/ultracode off` in one
   * session does not leak into another.
   */
  let defaultOn = false

  /** How a keyword mention behaves; set once at plugin init from the options tuple. */
  let keywordBehavior: KeywordBehavior = "one-shot"

  const stateOf = (sessionID: string): ModeState | undefined => sessions.get(sessionID)

  const reset = (): void => {
    sessions.clear()
    demoted.clear()
    processed.clear()
    defaultOn = false
    keywordBehavior = "one-shot"
  }

  return {
    setDefault(active: boolean): void {
      defaultOn = active
    },

    setKeywordBehavior(behavior: KeywordBehavior): void {
      keywordBehavior = behavior
    },

    getKeywordBehavior(): KeywordBehavior {
      return keywordBehavior
    },

    expireKeyword(sessionID: string): void {
      const state = sessions.get(sessionID)
      if (state?.source === "keyword") {sessions.delete(sessionID)}
    },

    enable(sessionID: string, source: ModeSource, fromMessageID?: string): void {
      // An explicit re-enable is a later instruction than an earlier "don't fan out", and wins.
      demoted.delete(sessionID)
      sessions.set(sessionID, { active: true, source, fromMessageID })
    },

    disable(sessionID: string): void {
      sessions.set(sessionID, { active: false, source: "command" })
    },

    stateOf,

    isActive(sessionID: string, agentName?: string): boolean {
      const state = sessions.get(sessionID)
      if (state) {return state.active}
      if (agentName === "ultracode") {return true}
      return defaultOn
    },

    demote(sessionID: string): void {
      demoted.add(sessionID)
    },

    isDemoted(sessionID: string): boolean {
      return demoted.has(sessionID)
    },

    markProcessedMessage(sessionID: string, messageID: string): boolean {
      let seen = processed.get(sessionID)
      if (seen === undefined) {
        seen = new Set<string>()
        processed.set(sessionID, seen)
      }
      if (seen.has(messageID)) {return false}
      seen.add(messageID)
      return true
    },

    reset,
  }
}

/**
 * Detects the one-shot keyword.
 *
 * Word-boundary matched, so "ultracoded" does not trigger it. Path mentions do
 * not trigger either: `src/ultracode.ts` or `ultracode.ts` names a FILE, and a
 * review-ranked danger is one stray mention raising the spend of every later
 * message — a filename is the likeliest accidental match. Sentence punctuation
 * stays a trigger: `Use ultracode.` ends with a period, and a period followed by
 * anything other than a word character is punctuation, not an extension. A false
 * NEGATIVE (the keyword quietly doing nothing) is the worse failure, so the
 * filter is narrow: path separators around the word, and a `.ext` suffix.
 */
export function mentionsKeyword(text: string): boolean {
  return /(?<![\w/\\-])ultracode(?![\w/\\-])(?<!\.[\w-])(?!\.[\w-])/iu.test(text)
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
