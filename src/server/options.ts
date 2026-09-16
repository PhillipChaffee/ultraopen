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
}

const DEFAULTS: UltraopenOptions = {
  concurrency: 8,
  ultracode: false,
  agentDeadlineMs: 4 * 60 * 60 * 1000,
  agentIdleMs: 5 * 60 * 1000,
  effortPreference: ["xhigh", "max", "high", "medium", "low"],
  runMode: "background",
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
    concurrency: clampConcurrency(input["concurrency"]),
    ultracode: input["ultracode"] === true || input["mode"] === "ultracode",
    agentDeadlineMs: clampTimeout(input["agentDeadlineMs"], DEFAULTS.agentDeadlineMs, true),
    agentIdleMs: clampTimeout(input["agentIdleMs"], DEFAULTS.agentIdleMs, false),
    effortPreference: stringArray(input["effortPreference"]) ?? DEFAULTS.effortPreference,
    runMode: resolveRunMode(input["runMode"]),
  }
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
 * Clamps concurrency into range.
 *
 * 0 is deliberately NOT honoured: `0 ?? 8` is `0`, and a limit below one makes every acquire wait
 * forever — a hang with no throw, no log and no progress.
 */
function clampConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {return DEFAULTS.concurrency}
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
