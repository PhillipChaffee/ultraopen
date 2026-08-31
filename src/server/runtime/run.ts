import { fail } from "../script/errors.js"
import { DEFAULT_AGENT_DEADLINE_MS, MAX_AGENTS_PER_RUN } from "../script/limits.js"
import { registry } from "../singleton.js"
import { type NullReason, type SpawnOutcome } from "../bridge/spawn.js"
import { spawnStructured } from "../bridge/structured.js"
import { Journal, type JournalEntry } from "../resume/journal.js"
import { toJournalEntry, toReplayedEntry, tryReplay } from "../resume/replay.js"
import { stableStringify } from "../resume/key.js"
import { breakScope, nextCallIdentity, rootScope, withScope, type Scope } from "../resume/scope.js"
import type { Ruleset } from "../bridge/permission.js"
import type { OpencodeClient } from "../types.js"

/** Options a script may pass to `agent()`. Mirrors the Workflow spec's opts bag. */
export type AgentOptions = {
  label?: string
  phase?: string
  schema?: Record<string, unknown>
  model?: string
  effort?: string
  agentType?: string
  isolation?: "worktree"
  disallowedTools?: readonly string[]
}

/** One agent's outcome, recorded so partial coverage can never read as full coverage. */
export type AgentRecord = {
  index: number
  label: string
  phase: string | undefined
  ok: boolean
  reason?: NullReason
  detail?: string
  sessionID?: string
  outputTokens: number
  /** True when this result came from a previous run's journal rather than a live call. */
  replayed?: boolean
}

export type ProgressEvent =
  | { type: "agent-start"; index: number; label: string; phase: string | undefined; sessionID?: string }
  | { type: "agent-end"; index: number; label: string; phase: string | undefined; ok: boolean; sessionID?: string }
  | { type: "phase"; title: string }
  | { type: "log"; message: string }

export type RunOptions = {
  runId: string
  client: OpencodeClient
  parentSessionID: string
  /**
   * Resolves an `effort` string against the target model's real variant map.
   *
   * Receives the resolved model, because variants belong to a model and an individual agent() call
   * may pin one that differs from the run default.
   */
  resolveVariant?:
    | ((effort: string | undefined, model?: { providerID: string; modelID: string } | undefined) => string | undefined)
    | undefined
  /** Parses a "provider/model" string into the prompt-body model ref. */
  resolveModel?: ((model: string | undefined) => { providerID: string; modelID: string } | undefined) | undefined
  inheritedPermission?: Ruleset | undefined
  /** Contract text appended to the child's system prompt (PromptInput.system appends). */
  subagentContract?: ((opts: AgentOptions) => string | undefined) | undefined
  deadlineMs?: number | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((event: ProgressEvent) => void) | undefined
  /** Journal entries from a previous run, indexed as replay candidates. */
  previousEntries?: readonly JournalEntry[] | undefined
  /** The run this one resumes, recorded on replayed entries so they are distinguishable. */
  resumedFrom?: string | undefined
  /** Root chain seed — the script hash, so any edit invalidates everything. */
  resumeSeed?: string | undefined
}

/**
 * The per-run engine context.
 *
 * Owns the agent counter, the phase/log narration, and the null ledger. One instance per workflow
 * invocation; the concurrency gate it uses is process-global (see `singleton.ts`).
 */
export class Run {
  readonly runId: string
  readonly records: AgentRecord[] = []
  readonly logs: string[] = []
  readonly journal: Journal

  #currentPhase: string | undefined
  #spawned = 0
  readonly #options: RunOptions
  readonly #journal: Journal
  readonly #rootScope: Scope
  readonly #resumedFrom: string | undefined

  constructor(options: RunOptions) {
    this.#options = options
    this.runId = options.runId
    this.#journal = new Journal()
    this.journal = this.#journal
    this.#resumedFrom = options.resumedFrom
    // Seeded from the script source, so editing the script anywhere invalidates the root chain
    // and nothing replays against a program that no longer exists.
    this.#rootScope = rootScope(options.resumeSeed ?? "root")
    if (options.previousEntries) this.#journal.loadPrevious(options.previousEntries)
  }

  /** Runs `work` with this run's root resume scope installed. */
  async withRootScope<T>(work: () => Promise<T>): Promise<T> {
    return await withScope(this.#rootScope, work)
  }

  get agentCount(): number {
    return this.#spawned
  }

  get currentPhase(): string | undefined {
    return this.#currentPhase
  }

  /** Agents that produced no usable result, with the reason for each. */
  get nulls(): AgentRecord[] {
    return this.records.filter((record) => !record.ok)
  }

  /** Output tokens across every child of this run. */
  get outputTokens(): number {
    return this.records.reduce((total, record) => total + record.outputTokens, 0)
  }

  phase = (title: string): void => {
    this.#currentPhase = title
    this.#options.onProgress?.({ type: "phase", title })
  }

  log = (message: string): void => {
    this.logs.push(message)
    this.#options.onProgress?.({ type: "log", message })
  }

  /**
   * Spawns one subagent.
   *
   * Returns the agent's text (or its structured object when a schema was supplied), or `null` when
   * it produced nothing usable. Never throws for agent-level failures — the spec makes `null` the
   * sentinel scripts filter on. Engine faults (the lifetime cap, an aborted run) DO throw, so they
   * cannot masquerade as an agent that simply returned nothing.
   */
  agent = async (prompt: string, options: AgentOptions = {}): Promise<unknown> => {
    if (typeof prompt !== "string" || prompt.trim() === "") {
      throw new TypeError("agent() requires a non-empty prompt string as its first argument.")
    }

    // Checked before the counter moves, so a rejected call does not inflate the count that the
    // result envelope reports.
    if (this.#spawned >= MAX_AGENTS_PER_RUN) {
      fail({
        kind: "LimitError",
        message: `Workflow exceeded ${MAX_AGENTS_PER_RUN} agents. This is a runaway-loop backstop.`,
        suggestions: ["Bound the loop explicitly, or split the work across several workflow runs."],
      })
    }

    // Claim identity synchronously, BEFORE awaiting a permit. Doing it after would make a call's
    // key depend on permit-grant order, which varies with timing — reintroducing exactly the
    // nondeterminism the scoped chain exists to remove.
    const index = this.#spawned
    this.#spawned++
    const identity = nextCallIdentity(prompt, options, this.#rootScope)

    const label = options.label ?? deriveLabel(prompt, index)
    const phase = options.phase ?? this.#currentPhase
    const schemaHash = options.schema ? stableStringify(options.schema) : undefined

    // Replay before spending anything. `forceLive` covers the sticky break: once a call in this
    // scope has missed, every later call in it must run live, because their upstream context
    // changed and a cached result belongs to a different execution.
    const hit = tryReplay(this.#journal, identity, schemaHash)
    if (hit) {
      this.#journal.record(toReplayedEntry(hit.entry, label, phase, this.#resumedFrom))
      this.#options.onProgress?.({ type: "agent-end", index, label, phase, ok: true })
      // Replayed spend counts as if paid, or a budget-guarded loop takes a different number of
      // trips on resume and the script's own control flow diverges.
      this.records.push({ index, label, phase, ok: true, outputTokens: hit.outputTokens, replayed: true })
      return hit.value
    }
    // A miss breaks the scope for everything after it.
    if (!identity.forceLive) breakScope(this.#rootScope)

    this.#options.onProgress?.({ type: "agent-start", index, label, phase })

    // The permit is held only for the spawn itself. Combinators deliberately do NOT gate, or a
    // parallel() nested in a pipeline() stage would deadlock behind its own outer item.
    const release = await registry.semaphore.acquire()
    let outcome: SpawnOutcome
    const model = this.#options.resolveModel?.(options.model)
    try {
      outcome = await spawnStructured(this.#options.client, {
        prompt,
        runId: this.runId,
        parentSessionID: this.#options.parentSessionID,
        label,
        ...pick("agentType", options.agentType),
        ...pick("schema", options.schema),
        ...pick("disallowedTools", options.disallowedTools),
        ...pick("model", model),
        ...pick("variant", this.#options.resolveVariant?.(options.effort, model)),
        ...pick("system", this.#options.subagentContract?.(options)),
        ...pick("inheritedPermission", this.#options.inheritedPermission),
        ...pick("deadlineMs", this.#options.deadlineMs ?? DEFAULT_AGENT_DEADLINE_MS),
        ...pick("signal", this.#options.signal),
      })
    } finally {
      release()
    }

    const record: AgentRecord = outcome.ok
      ? {
          index,
          label,
          phase,
          ok: true,
          outputTokens: outputTokensOf(outcome.info),
          ...pick("sessionID", outcome.sessionID),
        }
      : {
          index,
          label,
          phase,
          ok: false,
          reason: outcome.reason,
          detail: outcome.detail,
          outputTokens: 0,
          ...pick("sessionID", outcome.sessionID),
        }

    this.records.push(record)

    const value = outcome.ok ? (options.schema ? outcome.structured : outcome.text) : undefined
    this.#journal.record(
      toJournalEntry({
        identity,
        label,
        phase,
        schemaHash,
        outputTokens: record.outputTokens,
        ...(outcome.ok ? { ok: true, value } : { ok: false, reason: outcome.reason, detail: outcome.detail }),
      }),
    )

    this.#options.onProgress?.({
      type: "agent-end",
      index,
      label,
      phase,
      ok: outcome.ok,
      ...pick("sessionID", outcome.sessionID),
    })

    if (!outcome.ok) return null
    return value
  }

  /**
   * Releases every child session this run created.
   *
   * `SessionRunState.cancel` walks BackgroundJob entries, which a plugin cannot register, so plain
   * `session.create({parentID})` children are never cascaded to. Aborting them is ours to do or
   * they keep running — and billing — after the parent turn ends.
   */
  async abortAll(): Promise<void> {
    const sessions = registry.sessionsOf(this.runId)
    await Promise.all(
      sessions.map(async (sessionID) => {
        await this.#options.client.session.abort({ path: { id: sessionID } }).catch(() => undefined)
        registry.forget(sessionID)
      }),
    )
  }
}

/**
 * Reads output tokens defensively.
 *
 * The SDK types promise `tokens.output`, but the checked-in types have already drifted from the
 * server once, and an unexpected response shape must not crash a whole run with an opaque
 * "undefined is not an object". A missing count degrades to 0 — budget reporting under-counts,
 * which is visible, rather than the run dying, which is not.
 */
function outputTokensOf(info: { tokens?: { output?: number } }): number {
  const output = info.tokens?.output
  return typeof output === "number" && Number.isFinite(output) ? output : 0
}

/** Includes a key only when the value is present, which `exactOptionalPropertyTypes` requires. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

/** A short, stable label derived from the prompt when the script did not supply one. */
function deriveLabel(prompt: string, index: number): string {
  const firstLine = prompt.trim().split("\n", 1)[0] ?? ""
  const trimmed = firstLine.slice(0, 48).trim()
  return trimmed === "" ? `agent:${index}` : trimmed
}
