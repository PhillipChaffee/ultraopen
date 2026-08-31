/**
 * Hard limits, ported from the Claude Code Workflow tool spec.
 *
 * These are runaway-loop backstops, not tuning knobs. They are enforced in ultraopen's own host
 * functions rather than by the execution substrate.
 */

/** Max script source length, in characters. */
export const MAX_SCRIPT_CHARS = 524_288

/** Max agents across one workflow's entire lifetime. A backstop set far above any real workflow. */
export const MAX_AGENTS_PER_RUN = 1000

/** Max items accepted by a single parallel()/pipeline() call. Exceeding is an explicit error. */
export const MAX_ITEMS_PER_CALL = 4096

/**
 * Default concurrent agent spawns, process-wide across ALL runs.
 *
 * Deliberately a fixed constant rather than a CPU-derived formula: agent() is network-bound, and
 * none of the three real constraints (provider rate limits, the per-worktree git snapshot mutex,
 * the single sqlite write lane) scales with cores. opencode itself hardcodes every bounded
 * concurrency site. A cpus()-based formula would degrade to 2 on a small CI runner for no reason.
 */
export const DEFAULT_CONCURRENCY = 8
export const MIN_CONCURRENCY = 1
export const MAX_CONCURRENCY = 32

/**
 * Wall-clock ceiling for a single agent() call.
 *
 * MANDATORY, not optional. opencode retries provider failures with no attempt cap, and on the
 * ordinary headers-present path the backoff is capped only by RETRY_MAX_DELAY (~24.8 days).
 * Combined with the plugin client's `req.timeout = false`, one rate-limited agent would pin a
 * concurrency permit forever — and budget() is token-based, so it cannot see idle retry sleep.
 */
export const DEFAULT_AGENT_DEADLINE_MS = 15 * 60 * 1000

/**
 * Effort variants in descending PREFERENCE — which to reach for first when nothing specific was
 * asked for. `xhigh` outranks `max` deliberately: max costs far more for a marginal gain.
 *
 * This is NOT a strength ordering; see EFFORT_STRENGTH.
 */
export const EFFORT_PREFERENCE = ["xhigh", "max", "high", "medium", "low"] as const
export type Effort = (typeof EFFORT_PREFERENCE)[number]

/**
 * Every reasoning level opencode exposes, in ascending STRENGTH.
 *
 * This is a different order from the preference list: `max` really is stronger than `xhigh`, even
 * though we prefer not to pay for it. Downgrades must use this one — using the preference list
 * would resolve a request for "xhigh" on a model offering [low, medium, high, max] UP to "max",
 * spending more than was asked for.
 *
 * The set is wider than the Anthropic-shaped ladder suggests. Surveying every model the live
 * catalog reports gives 13 distinct variant sets, including two levels below "low":
 *
 *   ["none","minimal","low","medium","high","xhigh"]   gpt-5-family
 *   ["low","medium","high","xhigh","max"]              claude 4.7+/5
 *   ["low","medium","high","max"]                      claude 4.6-class
 *   ["high","max"]                                     claude sonnet-4, deepseek-v4-pro, glm-5.2
 *   ["low","medium","high"]                            gemini-3.1-pro, grok-4.5, gpt-5-codex
 *   ["max"]                                            kimi-k3
 *
 * The ordering is taken from opencode's own construction, which builds these arrays ascending:
 * `OPENAI_EFFORTS = ["none", "minimal", ...["low","medium","high"], "xhigh"]`, and `"minimal"` is
 * unshifted ahead of the widely-supported three.
 */
export const EFFORT_STRENGTH = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

/**
 * Levels that mean "actually think". `none` is an explicit OFF switch, not a weaker setting, so a
 * downgrade must never land on it — someone asking for xhigh has not asked for reasoning disabled.
 */
export const EFFORT_OFF = "none"
