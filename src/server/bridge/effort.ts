import { EFFORT_OFF, EFFORT_STRENGTH } from "../script/limits.js"

/**
 * Resolves a requested reasoning effort against a model's REAL variant map.
 *
 * `"xhigh"` is not a universal variant id. opencode resolves `model.variants[variant]` and an
 * unknown key yields `undefined`, which merges as `{}` — no error, no log, no thinking budget.
 * The `variant` field is typed as a bare optional string with no validation, so asking for an
 * effort a model does not support is a SILENT no-op: the "ultra" in ultracode simply evaporates.
 *
 * Every resolution is therefore explicit, and every downgrade is reported.
 */

export type EffortResolution = {
  /** The variant to send, or undefined to send none. */
  variant: string | undefined
  /** Set when the request could not be honoured exactly. */
  downgradedFrom?: string
  /** Human-readable note for the run log, present only when something changed. */
  note?: string
}

export type ModelVariants = {
  /** Variant ids the model actually supports, e.g. ["low","medium","high","xhigh","max"]. */
  available: readonly string[]
  /** For the message. */
  modelLabel?: string
}

/**
 * Picks the best supported variant for a requested effort.
 *
 * When the request is unsupported, falls back to the strongest variant the model does support that
 * is no stronger than the request — a request for "xhigh" on a model offering
 * ["low","medium","high","max"] resolves to "high", not "max", because silently escalating past
 * what was asked for would be its own surprise.
 */
export function resolveEffort(requested: string | undefined, model: ModelVariants): EffortResolution {
  const available = model.available.filter((entry) => typeof entry === "string" && entry !== "")
  if (requested === undefined || requested === "") return { variant: undefined }

  // "default" is opencode's own sentinel for "no variant".
  if (requested === "default") return { variant: undefined }

  if (available.includes(requested)) return { variant: requested }

  const label = model.modelLabel ?? "this model"

  if (available.length === 0) {
    return {
      variant: undefined,
      downgradedFrom: requested,
      note: `effort "${requested}" ignored — ${label} reports no reasoning variants`,
    }
  }

  const requestedRank = EFFORT_STRENGTH.indexOf(requested as (typeof EFFORT_STRENGTH)[number])
  if (requestedRank === -1) {
    return {
      variant: undefined,
      downgradedFrom: requested,
      note: `effort "${requested}" is not a known level — sending no variant (${label} supports ${available.join(", ")})`,
    }
  }

  // Prefer a DOWNGRADE: the strongest supported level at or below what was asked for. Scanning
  // the ascending ladder in reverse finds it. `none` is excluded — it is an explicit off switch,
  // not a weaker setting, and nobody asking for xhigh has asked for reasoning disabled.
  const downgrade = EFFORT_STRENGTH.slice(0, requestedRank + 1)
    .toReversed()
    .find((entry) => entry !== EFFORT_OFF && available.includes(entry))

  if (downgrade !== undefined) {
    return {
      variant: downgrade,
      downgradedFrom: requested,
      note: `effort "${requested}" unsupported by ${label} — using "${downgrade}"`,
    }
  }

  // Nothing weaker exists. Some models offer ONLY stronger levels — kimi-k3 exposes just ["max"] —
  // and refusing there would leave an ultracode run with no reasoning at all, which is further
  // from the request than overshooting by one rung.
  //
  // Bounded to ONE rung deliberately. Escalating freely would turn a request for "low" on that
  // same kimi-k3 into "max": a large, silent cost increase in the opposite direction from what
  // was asked. One rung is close enough to be a fair reading of intent; more is a different
  // decision the caller did not make. Beyond that, send no variant and let the model default.
  const nextUp = EFFORT_STRENGTH[requestedRank + 1]
  const escalation = nextUp !== undefined && available.includes(nextUp) ? nextUp : undefined
  if (escalation !== undefined) {
    return {
      variant: escalation,
      downgradedFrom: requested,
      note: `effort "${requested}" unsupported by ${label} — using "${escalation}", the nearest level it offers`,
    }
  }

  return {
    variant: undefined,
    downgradedFrom: requested,
    note: `effort "${requested}" unsupported by ${label}, which offers only ${available.join(", ")}`,
  }
}

/**
 * Builds a resolver bound to one model's variant map.
 *
 * `onDowngrade` is invoked for every silent-failure case, so the run log records what actually
 * happened rather than the caller assuming it got what it asked for.
 */
export function makeEffortResolver(
  model: ModelVariants,
  onDowngrade?: (note: string) => void,
): (effort: string | undefined) => string | undefined {
  return (effort) => {
    const resolution = resolveEffort(effort, model)
    if (resolution.note) onDowngrade?.(resolution.note)
    return resolution.variant
  }
}
