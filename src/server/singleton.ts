import { Semaphore } from "./runtime/semaphore.js"
import { DEFAULT_CONCURRENCY } from "./script/limits.js"

/**
 * Process-wide state, deliberately at MODULE level rather than in the plugin factory closure.
 *
 * opencode instantiates a plugin once per *directory* (InstanceState is a ScopedCache keyed by
 * directory), so factory-closure state is NOT shared: a worktree-isolated agent runs against a
 * second directory and would get a second, blind copy. Anything that must be globally true —
 * the concurrency cap, the set of engine-owned sessions, the run registry — has to live here.
 *
 * The concurrency cap in particular must be global: two concurrent workflow runs each holding
 * their own cap would double the real fan-out against a single sqlite write lane and a provider
 * with no rate limiter.
 */

/** Sessions this engine created. The recursion guard's in-memory layer, and the abort roster. */
const engineSessions = new Set<string>(),

/** Child session id -> the run that owns it, so aborts and budget roll up correctly. */
 sessionToRun = new Map<string, string>(),

/** Child session id -> which agent call of its run spawned it (index + label), for recordings (#150). */
 sessionAgents = new Map<string, { index: number; label: string }>(),

/** Child session id -> epoch ms of its last observed activity, for the idle deadline. */
 lastActivityAt = new Map<string, number>()

let semaphore = new Semaphore(DEFAULT_CONCURRENCY)

/** The per-agent identity a child session carries, once its run's engine spawned it. */
export interface AgentOwner {
  runId: string
  index: number
  label: string
}

export const registry = {
  /** The single global admission gate for agent spawns. */
  get semaphore(): Semaphore {
    return semaphore
  },

  /**
   * Applies a configured concurrency limit.
   *
   * First writer wins for the process; later calls only widen nothing and are ignored unless the
   * value differs, which keeps two projects in one server from fighting over the cap.
   */
  configureConcurrency(limit: number): void {
    const clamped = Semaphore.clamp(limit)
    if (clamped === semaphore.limit) {return}
    semaphore.resize(clamped)
  },

  /**
   * Registers a child session this engine created, with the agent call's identity when the
   * caller knows it (the run's live engine passes index + label; older or test callers may
   * omit it). The session→agent map is what scopes agent recordings (#150): the event hook
   * resolves the emitting session to `runId + index + label` and records under that name.
   */
  register(sessionID: string, runId: string, agent?: { index: number; label: string } | undefined): void {
    engineSessions.add(sessionID)
    sessionToRun.set(sessionID, runId)
    if (agent !== undefined) {sessionAgents.set(sessionID, agent)}
  },

  forget(sessionID: string): void {
    engineSessions.delete(sessionID)
    sessionToRun.delete(sessionID)
    sessionAgents.delete(sessionID)
    lastActivityAt.delete(sessionID)
  },

  /**
   * Records observed progress for an engine-owned child.
   *
   * Fed by the plugin's `event` hook (`message.part.updated` / `message.updated`), which is the
   * only progress signal that covers schema'd children — `format` poisons the REST message
   * listing, but the Bus emits part events live regardless. The idle deadline reads this map.
   */
  touchActivity(sessionID: string, at = Date.now()): void {
    if (!engineSessions.has(sessionID)) {return}
    lastActivityAt.set(sessionID, at)
  },

  /** Epoch ms of the child's last observed activity, 0 when never touched. */
  lastActivity(sessionID: string): number {
    return lastActivityAt.get(sessionID) ?? 0
  },

  /** True when the engine created this session — used to scope hooks and block recursion. */
  owns(sessionID: string): boolean {
    return engineSessions.has(sessionID)
  },

  runOf(sessionID: string): string | undefined {
    return sessionToRun.get(sessionID)
  },

  /**
   * The full owner of an engine-created child session — run id plus the agent call's index
   * and label (#150). The combination is the agent recording's filename contract: the event
   * hook records under exactly this triple. undefined for a session this process did not
   * create (foreign sessions never record), and also for one registered without an agent
   * identity — which reads, honestly, as no recording.
   */
  agentOf(sessionID: string): AgentOwner | undefined {
    const agent = sessionAgents.get(sessionID)
    const runId = sessionToRun.get(sessionID)
    if (agent === undefined || runId === undefined) {return undefined}
    return { runId, ...agent }
  },

  /** Live child sessions belonging to a run, for abort fan-out. */
  sessionsOf(runId: string): string[] {
    const out: string[] = []
    for (const [sessionID, id] of sessionToRun) {
      if (id === runId) {out.push(sessionID)}
    }
    return out
  },

  /** Drops every engine-owned session of a run when the run settles. */
  forgetRun(runId: string): void {
    for (const [sessionID, id] of sessionToRun) {
      if (id === runId) {registry.forget(sessionID)}
    }
  },

  get size(): number {
    return engineSessions.size
  },

  /** Test-only: restore a clean process-wide state. */
  resetForTests(): void {
    engineSessions.clear()
    sessionToRun.clear()
    sessionAgents.clear()
    lastActivityAt.clear()
    semaphore = new Semaphore(DEFAULT_CONCURRENCY)
  },
}
