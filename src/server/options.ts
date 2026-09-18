import { MAX_CONCURRENCY, MAX_TIMER_MS, MIN_CONCURRENCY } from "./script/limits.js"

/**
 * Plugin options, supplied via the tuple form in opencode.json:
 *
 *     { "plugin": [["ultraopen", { "concurrency": 8, "mode": "ultracode" }]] }
 *
 * This is the ONLY safe channel for a project-level flag. A new top-level opencode.json key is
 * hard-rejected — `ConfigParse` throws `Unrecognized keys` and breaks config loading entirely for
 * the user — and `experimental` is a closed struct, so keys nested there are dropped at decode.
 */
export interface UltraopenOptions {
  /** Process-wide concurrent agent spawns. Clamped; 0 is rejected rather than honoured. */
  concurrency: number
  /** When true, ultracode's standing opt-in applies from the first turn in this project. */
  ultracode: boolean
  /**
   * Live-run cap for an ultracode-active session: how many workflow runs may be
   * pending or running in it at once. Non-ultracode sessions keep the one-live-run
   * refusal regardless of this value.
   */
  ultracodeMaxRuns: number
  /** Wall-clock ceiling for a single agent, in milliseconds. 0 disables it; the idle limit remains. */
  agentDeadlineMs: number
  /** Inactivity bound for a single agent, in milliseconds. The timer resets on child progress. */
  agentIdleMs: number
  /** Effort preference, highest first. Resolved against each model's real variant map. */
  effortPreference: readonly string[]
  /**
   * Launch contract for the `workflow` tool. `background` returns the run id at
   * once and the run continues in the server process; `blocking` waits for the
   * final result, for one-shot hosts that kill the process after the turn.
   */
  runMode: "background" | "blocking"
  /**
   * How a plain `ultracode` keyword mention behaves. `one-shot` (default) fans
   * out exactly the task that said it; `session` keeps the old sticky behaviour.
   */
  keywordBehavior: "one-shot" | "session"
  /** Extra directories of saved workflow scripts, most specific last. */
  workflowPaths: readonly string[]
  /**
   * Output-token ceiling for one workflow run, shared by nested runs. Null
   * means no ceiling — today's behavior. Invalid values mean null rather than
   * the default, because silently capping an uncapped user is worse than not
   * capping them.
   */
  budgetTokens: number | null
  /** Size advice appended to the tool description; unset omits the line entirely. */
  sizeGuideline: string | undefined
}

const DEFAULTS: UltraopenOptions = {
  concurrency: 8,
  ultracode: false,
  ultracodeMaxRuns: 8,
  agentDeadlineMs: 4 * 60 * 60 * 1000,
  agentIdleMs: 5 * 60 * 1000,
  effortPreference: ["xhigh", "max", "high", "medium", "low"],
  runMode: "background",
  keywordBehavior: "one-shot",
  workflowPaths: [],
  budgetTokens: null,
  sizeGuideline: undefined,
}

/**
 * Normalises raw plugin options.
 *
 * Every field is defended rather than trusted: options come from a user-edited JSON file, and a
 * bad value here would otherwise surface much later as a hang or a silently ignored setting.
 */
export function resolveOptions(raw: unknown): UltraopenOptions {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULTS, runMode: resolveRunMode(undefined) }
  }
  const input = raw as Record<string, unknown>

  return {
    concurrency: clampCount(input["concurrency"], DEFAULTS.concurrency),
    ultracode: input["ultracode"] === true || input["mode"] === "ultracode",
    ultracodeMaxRuns: clampCount(input["ultracodeMaxRuns"], DEFAULTS.ultracodeMaxRuns),
    agentDeadlineMs: clampTimeout(input["agentDeadlineMs"], DEFAULTS.agentDeadlineMs, true),
    agentIdleMs: clampTimeout(input["agentIdleMs"], DEFAULTS.agentIdleMs, false),
    effortPreference: stringArray(input["effortPreference"]) ?? DEFAULTS.effortPreference,
    workflowPaths: stringArray(input["workflowPaths"]) ?? DEFAULTS.workflowPaths,
    budgetTokens: resolveBudgetTokens(input["budgetTokens"]),
    sizeGuideline: typeof input["sizeGuideline"] === "string" && input["sizeGuideline"].trim() !== ""
      ? input["sizeGuideline"] as string
      : DEFAULTS.sizeGuideline,
    runMode: resolveRunMode(input["runMode"]),
    keywordBehavior: resolveKeywordBehavior(input["keywordBehavior"]),
  }
}

/**
 * Validates the output-token ceiling.
 *
 * Only a positive finite number is honoured; anything else means "no ceiling".
 * An invalid value deliberately does NOT fall back to a default cap: a user who
 * mistyped would otherwise trade an uncapped run for a surprise limit.
 */
function resolveBudgetTokens(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {return DEFAULTS.budgetTokens}
  return Math.floor(value)
}

/** Validates the size advice; an unset or non-string value omits the line. */
function resolveKeywordBehavior(value: unknown): "one-shot" | "session" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined
  if (normalized === "one-shot" || normalized === "session") {return normalized}
  return "one-shot"
}

/**
 * Resolves the launch contract.
 *
 * `ULTRAOPEN_WORKFLOW_SYNC=1` forces the blocking contract REGARDLESS of the
 * option — it is the one-line kill switch, so a stale config value must not be
 * able to hold the process open against it. An unrecognized option value falls
 * back to this env/default order rather than throwing; plugin options come from
 * a user-edited JSON file and a hard throw would break config loading.
 */
export const SYNC_ENV = "ULTRAOPEN_WORKFLOW_SYNC"

function resolveRunMode(value: unknown): "background" | "blocking" {
  if (process.env[SYNC_ENV] === "1") {return "blocking"}
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined
  if (normalized === "blocking" || normalized === "background") {return normalized}
  return DEFAULTS.runMode
}

/**
 * Clamps a count option into [MIN_CONCURRENCY, MAX_CONCURRENCY].
 *
 * 0 is deliberately NOT honoured: `0 ?? 8` is `0`, and a limit below one makes every acquire wait
 * forever — a hang with no throw, no log and no progress. Shared by the two count-shaped options,
 * `concurrency` and `ultracodeMaxRuns`, so both reject a zero the same way.
 */
function clampCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {return fallback}
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.floor(value)))
}

/**
 * Validates a timer option into [allowZero ? 0 : 1, MAX_TIMER_MS].
 *
 * Values above MAX_TIMER_MS are clamped, never honoured: the platform's timers clamp delays past
 * 2^31-1 ms down to ~1ms, so "a huge ceiling to disable the bound" would otherwise invert into
 * every agent dying almost instantly.
 */
function clampTimeout(value: unknown, fallback: number, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < (allowZero ? 0 : 1)) {return fallback}
  return Math.min(MAX_TIMER_MS, value)
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {return undefined}
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
  return out.length > 0 ? out : undefined
}
