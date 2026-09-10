import { MAX_CONCURRENCY, MIN_CONCURRENCY } from "./script/limits.js"

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
  /** Wall-clock ceiling for a single agent, in milliseconds. */
  agentDeadlineMs: number
  /** Effort preference, highest first. Resolved against each model's real variant map. */
  effortPreference: readonly string[]
}

const DEFAULTS: UltraopenOptions = {
  concurrency: 8,
  ultracode: false,
  agentDeadlineMs: 15 * 60 * 1000,
  effortPreference: ["xhigh", "max", "high", "medium", "low"],
}

/**
 * Normalises raw plugin options.
 *
 * Every field is defended rather than trusted: options come from a user-edited JSON file, and a
 * bad value here would otherwise surface much later as a hang or a silently ignored setting.
 */
export function resolveOptions(raw: unknown): UltraopenOptions {
  if (typeof raw !== "object" || raw === null) {return { ...DEFAULTS }}
  const input = raw as Record<string, unknown>

  return {
    concurrency: clampConcurrency(input["concurrency"]),
    ultracode: input["ultracode"] === true || input["mode"] === "ultracode",
    agentDeadlineMs: positiveNumber(input["agentDeadlineMs"]) ?? DEFAULTS.agentDeadlineMs,
    effortPreference: stringArray(input["effortPreference"]) ?? DEFAULTS.effortPreference,
  }
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

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {return undefined}
  return value
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {return undefined}
  const out = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
  return out.length > 0 ? out : undefined
}
