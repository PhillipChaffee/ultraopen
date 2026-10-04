import type { NullReason } from "../bridge/spawn.js"

/**
 * The run journal: one record per agent call, append-only.
 *
 * Records COPY the agent's value rather than pointing at the child session that produced it.
 * Deleting a session recursively deletes its children, so a pointer-based journal would lose
 * exactly the transcripts a resume needs — and schema'd child sessions cannot be re-read at all,
 * because using `format` permanently breaks message listing for that session.
 */

export interface JournalEntry {
  type: "result"
  key: string
  scopePath: string
  ordinal: number
  label: string
  phase?: string | undefined
  /** "ok" is the ONLY status eligible for replay. */
  status: "ok" | "null"
  reason?: NullReason | undefined
  detail?: string | undefined
  /** The agent's value, copied in full. */
  value?: unknown
  /** Hash of the schema in force when this ran, so a schema edit invalidates the entry. */
  schemaHash?: string | undefined
  outputTokens: number
  /** Set when this entry was itself replayed, so a replayed empty is distinguishable. */
  replayed?: boolean
  sourceRunId?: string | undefined
  /** 1 = first attempt; 2+ = a restart after a deadline kill, same key by design. */
  attempt?: number | undefined
}

/**
 * The abort reason the stop path carries on its signal; the journal records it per aborted
 * agent, which is how a deliberate stop is told apart from a parent-turn interrupt — and how
 * the stop's own cancellation is told apart from a run that failed for its own reasons.
 */
export const STOP_ABORT_REASON = "stopped by request"

/**
 * The run-control channel's abort reason: the canonical stop reason plus the provenance of
 * the surface that requested it (#134). The suffix is what the journal records and what a
 * stopped run's failure surface quotes, so the debugging direction survives the process
 * that stopped it. `isStopAbortDetail` reads both through one recognizer.
 */
export const CONTROL_STOP_ABORT_REASON = `${STOP_ABORT_REASON} (run-control channel)`

/**
 * True when a journal entry's detail records a stop-path abort.
 *
 * The bare reason is the tool stop's (`workflow({ stop })`); the control channel's carries
 * its provenance as a parenthesized suffix. Matching the exact bare string and that
 * documented suffix shape keeps the two discriminators — the cancel write's re-claim and
 * the never-auto-resume sweep — honest for both stops, while an arbitrary failure detail
 * (server error strings reach the journal verbatim) can only collide by literally opening
 * with the reason plus an opening parenthesis. The `typeof` guard is load-bearing:
 * parseJournal tolerates hand-edited journals whose `detail` is any JSON, and a non-string
 * must read as "not a stop", never throw through the recognizer.
 */
export function isStopAbortDetail(detail: string | undefined): boolean {
  return detail === STOP_ABORT_REASON || (typeof detail === "string" && detail.startsWith(`${STOP_ABORT_REASON} (`))
}

export interface Manifest {
  runId: string
  bootId: string
  pid: number
  /**
   * The session that launched the run. REQUIRED — written by every manifest writer since
   * the first run store (M3), so a manifest on disk without it is corrupt, not a
   * pre-upgrade format; the resume gate refuses such a manifest as unverifiable
   * provenance rather than reporting it as a foreign session ("different session
   * (undefined)").
   */
  sessionID: string
  sourceHash: string
  argsHash: string
  /**
   * The launch's `args` value, persisted verbatim so an auto-resume can
   * re-execute without anyone re-supplying it. Absent on manifests written
   * before auto-resume existed; the auto-resume sweep re-hashes what it finds
   * against `argsHash` and skips the run on a mismatch, so a hand-edited or
   * pre-feature manifest can never replay against guessed inputs.
   */
  args?: unknown
  /**
   * The raw string the boundary received for `args`, recorded ONLY when it hydrated a
   * stringified JSON payload (#78): `args` then holds the hydrated value, and this field
   * preserves what the caller actually sent, so the transport repair is diagnosable from the
   * manifest alone. Absent on non-hydrated launches.
   */
  argsRawString?: string
  /** `cancelled` is written by the stop path: the run was stopped by request, not by failure. */
  status: "running" | "completed" | "failed" | "cancelled" | "orphaned"
  childSessionIDs: string[]
  startedAt: number
  endedAt?: number
}

/**
 * An in-memory journal for one run, plus the replay index built from a previous run.
 *
 * Kept free of filesystem concerns so it can be exercised without touching disk; persistence is
 * the store's job.
 */
export class Journal {
  readonly entries: JournalEntry[]
  readonly #replayable: Map<string, JournalEntry>

  constructor() {
    this.entries = []
    this.#replayable = new Map()
  }

  /**
   * Loads a previous run's entries as replay candidates.
   *
   * Only `ok` entries are indexed. Replaying a recorded failure would make a resume look like it
   * covered everything when it actually recovered nothing — the precise failure the spec's
   * debugging procedure exists to catch.
   */
  loadPrevious(entries: readonly JournalEntry[]): void {
    for (const entry of entries) {
      if (entry.status !== "ok") {continue}
      this.#replayable.set(entry.key, entry)
    }
  }

  get replayableCount(): number {
    return this.#replayable.size
  }

  /**
   * Looks up a cached result.
   *
   * `schemaHash` must match the CURRENT call's schema. The key already covers the schema, but a
   * second check is cheap and catches a journal that was hand-edited or written by an older
   * format — a stale value silently satisfying a changed schema is the worst outcome here.
   */
  lookup(key: string, schemaHash: string | undefined): JournalEntry | undefined {
    const entry = this.#replayable.get(key)
    if (!entry) {return undefined}
    if (entry.schemaHash !== schemaHash) {return undefined}
    return entry
  }

  record(entry: JournalEntry): void {
    this.entries.push(entry)
  }

  /** Newline-delimited JSON, one record per line. */
  serialize(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join("\n")
  }

  get stats(): { total: number; ok: number; failed: number; replayed: number } {
    // One pass rather than three filters: the counts are always read together.
    let ok = 0,
     replayed = 0
    for (const entry of this.entries) {
      if (entry.status === "ok") {ok++}
      if (entry.replayed === true) {replayed++}
    }
    return { total: this.entries.length, ok, failed: this.entries.length - ok, replayed }
  }
}

/**
 * Parses a journal file.
 *
 * Tolerant by design: a truncated final line from an interrupted run must not make the whole
 * journal unreadable, since that file is the only way to recover such a run.
 */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") {continue}
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isEntry(parsed)) {entries.push(parsed)}
    } catch {
      // Skip an unparseable line rather than failing the load.
    }
  }
  return entries
}

function isEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) {return false}
  const record = value as Record<string, unknown>
  return (
    record["type"] === "result" &&
    typeof record["key"] === "string" &&
    (record["status"] === "ok" || record["status"] === "null")
  )
}
