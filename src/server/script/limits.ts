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
 * Inactivity bound for a single agent() call.
 *
 * The PRIMARY runaway backstop, and the one that catches the real failure mode: a stalled provider
 * produces no events, so the idle timer fires within minutes of the stall instead of waiting out a
 * wall clock. opencode retries provider failures with no attempt cap (see DEFAULT_AGENT_DEADLINE_MS
 * for the arithmetic), and an idle agent is exactly the shape a retry storm takes.
 */
export const DEFAULT_AGENT_IDLE_MS = 5 * 60 * 1000

/**
 * Wall-clock ceiling for a single agent() call, generous because real workflow agents legitimately
 * run for hours (Claude Code has no per-agent ceiling at all).
 *
 * MANDATORY as a pathology bound, not a productivity bound: it exists so an agent that keeps
 * emitting events forever without finishing cannot hold a concurrency permit indefinitely.
 * `0` disables it entirely; the idle limit then remains as the sole backstop.
 */
export const DEFAULT_AGENT_DEADLINE_MS = 4 * 60 * 60 * 1000

/** Max automatic restarts of one agent after a deadline kill. Bounds the restart loop. */
export const MAX_AGENT_RESTARTS = 3

/**
 * The largest delay the platform's timers honour.
 *
 * Node clamps setTimeout delays above 2^31-1 ms down to ~1ms, so a value past this would make
 * every bound fire almost instantly — the exact inverse of a user setting a huge ceiling to
 * disable it. Options are clamped here rather than trusted.
 */
export const MAX_TIMER_MS = 2_147_483_647

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
