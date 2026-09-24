import { fail } from "../script/errors.js"
import { DEFAULT_AGENT_DEADLINE_MS, DEFAULT_AGENT_IDLE_MS, LARGE_RUN_AGENTS, LARGE_RUN_PROJECTED_TOKENS, MAX_AGENTS_PER_RUN, MAX_AGENT_RESTARTS } from "../script/limits.js"
import { registry } from "../singleton.js"
import type { ControlAction, ControlCommand } from "./control.js"
import type { NullReason } from "../bridge/spawn.js"
import { spawnStructured } from "../bridge/structured.js"
import { Journal } from "../resume/journal.js"
import type { JournalEntry } from "../resume/journal.js"
import { toJournalEntry, toReplayedEntry, tryReplay } from "../resume/replay.js"
import { stableStringify } from "../resume/key.js"
import { breakScope, nextCallIdentity, rootScope, withScope } from "../resume/scope.js"
import type { Scope } from "../resume/scope.js"
import { assertWithinBudget, makeBudget } from "./budget.js"
import type { Budget } from "./budget.js"
import { createWorktree } from "../bridge/isolation.js"
import type { Ruleset } from "../bridge/permission.js"
import type { OpencodeClient } from "../types.js"

/** Options a script may pass to `agent()`. Mirrors the Workflow spec's opts bag. */
export interface AgentOptions {
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
export interface AgentRecord {
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
  | { type: "agent-end"; index: number; label: string; phase: string | undefined; ok: boolean; outputTokens?: number; sessionID?: string }
  | { type: "phase"; title: string }
  | { type: "log"; message: string }

export interface RunOptions {
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
  /** Inactivity bound per agent; 0 disables it. Idle resets on observed child progress. */
  idleMs?: number | undefined
  signal?: AbortSignal | undefined
  onProgress?: ((event: ProgressEvent) => void) | undefined
  /** Called with each journal entry the moment it is recorded — incremental flush, not endRun. */
  onJournal?: ((entry: JournalEntry) => void) | undefined
  /** Journal entries from a previous run, indexed as replay candidates. */
  previousEntries?: readonly JournalEntry[] | undefined
  /** The run this one resumes, recorded on replayed entries so they are distinguishable. */
  resumedFrom?: string | undefined
  /** Root chain seed. Callers seed it from the args hash: `args` is invisible to the per-call
   * chain but can change every result, so a change must invalidate everything — while script
   * edits stay incrementally replayable (see tool/workflow.ts). */
  resumeSeed?: string | undefined
  /** Output-token ceiling for the run, or null for none. */
  budgetTotal?: number | null | undefined
  /** Repository root, enabling `isolation: "worktree"`. */
  worktreeRoot?: string | undefined
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
  #largeRunWarned = false
  /** One controller per in-flight agent, so a stop-agent can abort exactly one child. */
  readonly #agentControllers = new Map<number, AbortController>()
  readonly #options: RunOptions
  readonly #journal: Journal
  readonly #rootScope: Scope
  readonly #resumedFrom: string | undefined
  readonly #budget: Budget
  readonly #worktrees: (() => Promise<void>)[] = []

  constructor(options: RunOptions) {
    this.#options = options
    this.runId = options.runId
    this.#journal = new Journal()
    this.journal = this.#journal
    this.#resumedFrom = options.resumedFrom
    // Seeded from the script source, so editing the script anywhere invalidates the root chain
    // and nothing replays against a program that no longer exists.
    this.#rootScope = rootScope(options.resumeSeed ?? "root")
    this.#budget = makeBudget({ total: options.budgetTotal ?? null, spent: () => this.outputTokens })
    if (options.previousEntries) {this.#journal.loadPrevious(options.previousEntries)}
  }

  /** The `budget` global handed to the script. */
  get budget(): Budget {
    return this.#budget
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

  /**
   * Runs one control command from the TUI's control file.
   *
   * Unknown or unsupported actions are logged, never a crash. Every action here
   * is safe to run twice (the cursor skips consumed sequences; a crash between
   * consume and acknowledge replays a safe action).
   */
  handleControl(command: ControlCommand): void {
    const who = command.target === undefined ? "" : ` (agent ${command.target})`
    switch (command.action) {
      case "pause": {
        registry.semaphore.pause()
        this.log("control: run paused — in-flight agents finish, no new agent starts.")
        break
      }
      case "resume": {
        registry.semaphore.resume()
        this.log("control: run resumed.")
        break
      }
      case "stop-run": {
        this.log("control: stop requested — aborting every in-flight agent.")
        void this.abortAll()
        break
      }
      case "stop-agent": {
        const controller = command.target === undefined ? undefined : this.#agentControllers.get(command.target)
        if (!controller) {
          this.log(`control: stop-agent ${command.target ?? ""} — no in-flight agent with that index; ignored.`)
          break
        }
        controller.abort()
        this.log(`control: agent ${command.target} stopped — its siblings are untouched.`)
        break
      }
      case "restart-agent": {
        // The manual key lands with the TUI selection slice (run-control T5);
        // the in-flight mechanism exists — a synthetic idle-deadline abort —
        // but the finished/failed agent path needs the journal restart first.
        this.log(`control: restart-agent${who} is not implemented yet; the automatic restart after an idle kill is the supported path.`)
        break
      }
    }
  }

  /** The control commands this run accepts, exposed for the watcher's dispatch. */
  get controlActions(): readonly ControlAction[] {
    return ["pause", "resume", "stop-run", "stop-agent", "restart-agent"]
  }

  /**
   * Fires the large-run advice once, when the run crosses the advisory thresholds.
   *
   * ADVICE ONLY — it never pauses or stops anything. Both numbers come from
   * constants so the result note and the strip badge agree on the definition.
   * The token projection uses the observed average of COMPLETED agents: early
   * in a run it under-counts, which is the honest direction for advice.
   */
  maybeWarnLargeRun(): void {
    if (this.#largeRunWarned) {return}
    if (this.#spawned < LARGE_RUN_AGENTS && this.#projectedTokens() < LARGE_RUN_PROJECTED_TOKENS) {return}
    this.#largeRunWarned = true
    const projection = this.#projectedTokens() > 0 ? `, projected output ≈ ${this.#projectedTokens()} tokens` : ""
    this.log(`large-run warning: ${this.#spawned} agents scheduled${projection} — check the script's fan-out if this is larger than intended.`)
  }

  #projectedTokens(): number {
    // The run's actual spend so far: the only number that cannot lie. The
    // average-per-agent refinement adds noise for no advisory value.
    return this.outputTokens
  }

  /** True when the run crossed the large-run advisory thresholds. */
  get isLargeRun(): boolean {
    return this.#spawned >= LARGE_RUN_AGENTS || this.#projectedTokens() >= LARGE_RUN_PROJECTED_TOKENS
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

    // Checked before the call is made: spending past the target and then reporting it would
    // defeat the point of a ceiling.
    assertWithinBudget(this.#budget)

    // Claim identity synchronously, BEFORE awaiting a permit. Doing it after would make a call's
    // key depend on permit-grant order, which varies with timing — reintroducing exactly the
    // nondeterminism the scoped chain exists to remove.
    const index = this.#spawned
    this.#spawned++
    const identity = nextCallIdentity(prompt, options, this.#rootScope),

     label = options.label ?? deriveLabel(prompt, index),
     phase = options.phase ?? this.#currentPhase,
     schemaHash = options.schema ? stableStringify(options.schema) : undefined,

    // Replay before spending anything. `forceLive` covers the sticky break: once a call in this
    // scope has missed, every later call in it must run live, because their upstream context
    // changed and a cached result belongs to a different execution.
     hit = tryReplay(this.#journal, identity, schemaHash)
    if (hit) {
      const replayed = toReplayedEntry(hit.entry, label, phase, this.#resumedFrom)
      this.#journal.record(replayed)
      this.#options.onJournal?.(replayed)
      this.#options.onProgress?.({ type: "agent-end", index, label, phase, ok: true, outputTokens: hit.outputTokens })
      this.maybeWarnLargeRun()
      // Replayed spend counts as if paid, or a budget-guarded loop takes a different number of
      // trips on resume and the script's own control flow diverges.
      this.records.push({ index, label, phase, ok: true, outputTokens: hit.outputTokens, replayed: true })
      return hit.value
    }
    // A miss breaks the scope for everything after it.
    if (!identity.forceLive) {breakScope(this.#rootScope)}

    // One controller per in-flight agent, so a stop-agent aborts exactly one
    // child and leaves its siblings untouched.
    const agentController = new AbortController()
    this.#agentControllers.set(index, agentController)
    this.#options.onProgress?.({ type: "agent-start", index, label, phase })
    this.maybeWarnLargeRun()

    // The permit is held only for the spawn itself. Combinators deliberately do NOT gate, or a
    // parallel() nested in a pipeline() stage would deadlock behind its own outer item.
    // acquire() also rejects promptly if the parent aborts while queued.
    const release = await registry.semaphore.acquire(this.#options.signal)
    try {
      // Fail HERE rather than after paying for a worktree and a child session that would be
      // aborted on first prompt.
      if (this.#options.signal?.aborted) {
        fail({ kind: "RuntimeError", message: "The run was aborted before this agent could start." })
      }
      const model = this.#options.resolveModel?.(options.model),
       worktree =
        options.isolation === "worktree" && this.#options.worktreeRoot
          ? await createWorktree({ worktreeRoot: this.#options.worktreeRoot, label, onNote: this.log })
          : undefined
      if (worktree) {this.#worktrees.push(worktree.release)}
      const spawnOptions = {
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
        ...pick("idleMs", this.#options.idleMs ?? DEFAULT_AGENT_IDLE_MS),
        ...pick("signal", agentSignal(this.#options.signal, this.#agentControllers, index)),
        ...pick("directory", worktree?.directory),
      }
      let outcome = await spawnStructured(this.#options.client, spawnOptions)

      // An IDLE kill is a stall, and a fresh attempt usually finishes fast — so the agent restarts
      // in place, reusing the permit this call already holds. Re-acquiring would deadlock at
      // concurrency 1; the budget is re-asserted per attempt, per the no-shortcut rule. A
      // wall-clock kill is NEVER restarted: it means the agent produced continuously for the
      // whole ceiling, and a fresh attempt would just re-pay hours of work. Aborts are never
      // restarted (that fights the user), and schema misses belong to the structured ladder.
      let attempt = 1
      while (
        !outcome.ok &&
        outcome.reason === "idle-deadline" &&
        attempt <= MAX_AGENT_RESTARTS &&
        !this.#options.signal?.aborted
      ) {
        // The failed attempt's entry lands BEFORE the retry, so the forensics survive a crash
        // mid-restart and the newest ok entry per key wins replay.
        const failedEntry = toJournalEntry({
          identity,
          label,
          phase,
          schemaHash,
          outputTokens: 0,
          attempt,
          ok: false,
          reason: outcome.reason,
          detail: outcome.detail,
        })
        this.#journal.record(failedEntry)
        this.#options.onJournal?.(failedEntry)
        assertWithinBudget(this.#budget)
        attempt++
        this.log(`"${label}" hit its deadline and is being restarted (attempt ${attempt})`)
        outcome = await spawnStructured(this.#options.client, spawnOptions)
      }

      // A parent abort that lands during a stall can win the race as a deadline kill; report it
      // as what it was, or the failures list misattributes the user's own interrupt.
      //
      // An abort whose reason is a STRING names the requester (today only the stop path aborts
      // with a string — see STOP_ABORT_REASON), so the journal can tell a deliberate stop apart
      // from a parent-turn interrupt: the boot-time auto-resume sweep skips any run whose
      // children recorded that reason, honoring "stopped runs never resume".
      const aborted = this.#options.signal?.aborted === true,
        stopReason = aborted && typeof this.#options.signal?.reason === "string" && this.#options.signal.reason.trim() !== ""
          ? this.#options.signal.reason
          : undefined

      let finalOutcome = outcome
      if (!outcome.ok && outcome.reason === "deadline" && aborted) {
        finalOutcome = { ...outcome, reason: "aborted" as const, detail: stopReason ?? "parent aborted" }
      } else if (!outcome.ok && outcome.reason === "aborted" && stopReason !== undefined) {
        finalOutcome = { ...outcome, detail: stopReason }
      }

      const record: AgentRecord = finalOutcome.ok
        ? {
            index,
            label,
            phase,
            ok: true,
            outputTokens: outputTokensOf(finalOutcome.info),
            ...pick("sessionID", finalOutcome.sessionID),
          }
        : {
            index,
            label,
            phase,
            ok: false,
            reason: finalOutcome.reason,
            detail: finalOutcome.detail,
            outputTokens: 0,
            ...pick("sessionID", finalOutcome.sessionID),
          }

      this.records.push(record)

      let value: unknown = undefined
      if (finalOutcome.ok) {
        value = options.schema ? finalOutcome.structured : finalOutcome.text
      }
      const entry = toJournalEntry({
        identity,
        label,
        phase,
        schemaHash,
        outputTokens: record.outputTokens,
        attempt,
        ...(finalOutcome.ok ? { ok: true, value } : { ok: false, reason: finalOutcome.reason, detail: finalOutcome.detail }),
      })
      this.#journal.record(entry)
      this.#options.onJournal?.(entry)

      this.#options.onProgress?.({
        type: "agent-end",
        index,
        label,
        phase,
        ok: finalOutcome.ok,
        ...pick("outputTokens", this.records.at(-1)?.outputTokens),
        ...pick("sessionID", finalOutcome.sessionID),
      })
      this.maybeWarnLargeRun()

      if (!finalOutcome.ok) {return null}
      return value
    } finally {
      release()
      this.#agentControllers.delete(index)
    }
  }

  /**
   * Releases every child session this run created.
   *
   * `SessionRunState.cancel` walks BackgroundJob entries, which a plugin cannot register, so plain
   * `session.create({parentID})` children are never cascaded to. Aborting them is ours to do or
   * they keep running — and billing — after the parent turn ends.
   */
  async abortAll(): Promise<void> {
    // Worktrees are released first: they hold the agents' working directories, and removing one
    // while its session is still live is what the host's own retry loop exists to paper over.
    await Promise.all(this.#worktrees.map((release) => release().catch(() => undefined)))
    this.#worktrees.length = 0

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

/**
 * The signal the bridge sees for one agent: the run's own signal AND the
 * per-agent controller, combined. Aborting either aborts exactly this child.
 */
function agentSignal(runSignal: AbortSignal | undefined, controllers: Map<number, AbortController>, index: number): AbortSignal | undefined {
  const controller = controllers.get(index)
  if (controller === undefined) {return runSignal}
  if (runSignal === undefined) {return controller.signal}
  const combined = new AbortController()
  const forward = (): void => combined.abort()
  runSignal.addEventListener("abort", forward, { once: true })
  controller.signal.addEventListener("abort", forward, { once: true })
  return combined.signal
}

/**
 * A short, stable label derived from the prompt when the script did not supply one.
 *
 * The label persists into the child session's title and metadata, so a prompt fragment can end
 * up in the session database. That is the user's own machine and conversation, but a script
 * handling sensitive prompts should pass explicit `label`s — or rely on the `agent:${index}`
 * fallback here by keeping prompts' first lines free of anything they would not store.
 */
function deriveLabel(prompt: string, index: number): string {
  const firstLine = prompt.trim().split("\n", 1)[0] ?? "",
   trimmed = firstLine.slice(0, 48).trim()
  return trimmed === "" ? `agent:${index}` : trimmed
}
