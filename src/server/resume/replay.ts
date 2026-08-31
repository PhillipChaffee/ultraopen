import type { Journal, JournalEntry } from "./journal.js"
import type { CallIdentity } from "./scope.js"
import type { NullReason } from "../bridge/spawn.js"

/**
 * The replay decision for one agent() call, and the record written afterwards.
 *
 * Split from the Run so the three poisoning rules live in one place where they can be read
 * together, rather than interleaved with spawn plumbing.
 */

export type ReplayHit = {
  value: unknown
  outputTokens: number
  entry: JournalEntry
}

/**
 * Looks for a cached result for this call.
 *
 * Three rules decide eligibility, each protecting against a different way a resume can lie:
 *
 * 1. A broken scope forces a live call. Once an earlier call in the same scope missed, everything
 *    after it has different upstream context, so its cached value belongs to a different program.
 * 2. Only `ok` entries replay. Replaying a recorded failure would make a resume look like it
 *    covered everything when it recovered nothing — enforced when the index is built.
 * 3. The schema must match. The key already covers it, but a hand-edited or older-format journal
 *    could otherwise satisfy a changed schema with a stale value.
 */
export function tryReplay(
  journal: Journal,
  identity: CallIdentity,
  schemaHash: string | undefined,
): ReplayHit | undefined {
  if (identity.forceLive) return undefined
  const entry = journal.lookup(identity.key, schemaHash)
  if (!entry) return undefined
  return { value: entry.value, outputTokens: entry.outputTokens, entry }
}

export type OutcomeRecord = {
  identity: CallIdentity
  label: string
  phase: string | undefined
  schemaHash: string | undefined
  outputTokens: number
} & ({ ok: true; value: unknown } | { ok: false; reason: NullReason; detail: string })

/** Builds the journal entry for a live call. */
export function toJournalEntry(input: OutcomeRecord): JournalEntry {
  const base = {
    type: "result" as const,
    key: input.identity.key,
    scopePath: input.identity.scopePath,
    ordinal: input.identity.ordinal,
    label: input.label,
    phase: input.phase,
    schemaHash: input.schemaHash,
    outputTokens: input.outputTokens,
  }

  // The VALUE is copied, never a pointer to the child session: deleting a parent session
  // recursively deletes its children, and a schema'd child cannot be re-read at all because using
  // `format` permanently breaks message listing for that session.
  return input.ok
    ? { ...base, status: "ok", value: input.value }
    : { ...base, status: "null", reason: input.reason, detail: input.detail }
}

/** Builds the journal entry recorded when a call was satisfied from cache. */
export function toReplayedEntry(entry: JournalEntry, label: string, phase: string | undefined, sourceRunId: string | undefined): JournalEntry {
  // `replayed` and `sourceRunId` make a replayed empty visually distinct from a fresh empty, which
  // is what the spec's debugging procedure relies on when diagnosing a suspicious result.
  return { ...entry, label, phase, replayed: true, sourceRunId }
}
