import { LARGE_WORKFLOW_AGENTS, MAX_CONCURRENCY, MAX_TIMER_MS, MIN_CONCURRENCY } from "./script/limits.js"

/** Default resume window for runs interrupted by a process death, in hours. */
const DEFAULT_AUTO_RESUME_TTL_HOURS = 24

/** Ceiling for the resume window: a year. Beyond that "resume it" means "keep it forever". */
const MAX_AUTO_RESUME_TTL_HOURS = 24 * 365

/** Ceiling for per-boot auto-resumes; each is a full run, so this stays a backstop, not a knob. */
const MAX_AUTO_RESUME = 64

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
   * Output-token ceiling per launch: one launch and every nested run it spawns
   * share that family ceiling, and concurrent launches each hold their own —
   * a session of N live runs can spend N × ceiling, intended. Null means no
   * ceiling — today's behavior. Invalid values mean null rather than the
   * default, because silently capping an uncapped user is worse than not
   * capping them.
   */
  budgetTokens: number | null
  /**
   * Projected agent count at which a launch is flagged as a large workflow in
   * the permission prompt and the launch handle. The projection is advisory —
   * it never blocks or caps anything.
   */
  largeWorkflowAgents: number
  /** Size advice appended to the tool description; unset omits the line entirely. */
  sizeGuideline: string | undefined
  /**
   * Auto-resume-on-boot: when true (the default), a run interrupted by a process
   * death is re-executed from its journal on the next start, within
   * {@linkcode autoResumeTtlHours}, and its original session is hydrated with
   * the outcome. `false` restores the manual-resume-only behaviour.
   */
  autoResume: boolean
  /**
   * How long an interrupted run stays worth resuming, in hours. Runs whose
   * interruption is older are left orphaned (and eventually pruned). Invalid
   * values fall back to the default rather than silently disabling resume.
   */
  autoResumeTtlHours: number
  /** How many interrupted runs may auto-resume at one boot. Minimum 1. */
  autoResumeMax: number
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
  largeWorkflowAgents: LARGE_WORKFLOW_AGENTS,
  sizeGuideline: undefined,
  autoResume: true,
  autoResumeTtlHours: DEFAULT_AUTO_RESUME_TTL_HOURS,
  autoResumeMax: 1,
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
    largeWorkflowAgents: resolveLargeWorkflowAgents(input["largeWorkflowAgents"]),
    sizeGuideline: typeof input["sizeGuideline"] === "string" && input["sizeGuideline"].trim() !== ""
      ? input["sizeGuideline"] as string
      : DEFAULTS.sizeGuideline,
    runMode: resolveRunMode(input["runMode"]),
    keywordBehavior: resolveKeywordBehavior(input["keywordBehavior"]),
    autoResume: input["autoResume"] !== false,
    autoResumeTtlHours: resolveTtlHours(input["autoResumeTtlHours"]),
    autoResumeMax: resolveAutoResumeMax(input["autoResumeMax"]),
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

/**
 * Validates the launch advisory threshold.
 *
 * Same stance as the budget: only a positive finite number is honoured, and an invalid value
 * falls back to the default rather than disabling the advisory — a mistyped threshold must not
 * silently turn the large-workflow warning off.
 */
function resolveLargeWorkflowAgents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {return DEFAULTS.largeWorkflowAgents}
  return Math.floor(value)
}

/** Validates the size advice; an unset or non-string value omits the line. */
function resolveKeywordBehavior(value: unknown): "one-shot" | "session" {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined
  if (normalized === "one-shot" || normalized === "session") {return normalized}
  return "one-shot"
}

/**
 * Validates the resume window in hours.
 *
 * Same stance as the other numeric options: only a positive finite number is
 * honoured, and an invalid value falls back to the default rather than
 * disabling auto-resume — a mistyped TTL must not silently turn durability off.
 */
function resolveTtlHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {return DEFAULT_AUTO_RESUME_TTL_HOURS}
  return Math.min(MAX_AUTO_RESUME_TTL_HOURS, Math.floor(value))
}

/**
 * Validates the per-boot resume cap.
 *
 * Minimum 1: 0 would make the option a second, confusing kill switch alongside
 * `autoResume: false`, so a zero is treated as mistyped and falls back.
 */
function resolveAutoResumeMax(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {return DEFAULTS.autoResumeMax}
  return Math.min(MAX_AUTO_RESUME, Math.floor(value))
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
