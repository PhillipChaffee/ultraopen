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
 sessionToRun = new Map<string, string>()

let semaphore = new Semaphore(DEFAULT_CONCURRENCY)

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

  register(sessionID: string, runId: string): void {
    engineSessions.add(sessionID)
    sessionToRun.set(sessionID, runId)
  },

  forget(sessionID: string): void {
    engineSessions.delete(sessionID)
    sessionToRun.delete(sessionID)
  },

  /** True when the engine created this session — used to scope hooks and block recursion. */
  owns(sessionID: string): boolean {
    return engineSessions.has(sessionID)
  },

  runOf(sessionID: string): string | undefined {
    return sessionToRun.get(sessionID)
  },

  /** Live child sessions belonging to a run, for abort fan-out. */
  sessionsOf(runId: string): string[] {
    const out: string[] = []
    for (const [sessionID, id] of sessionToRun) {
      if (id === runId) {out.push(sessionID)}
    }
    return out
  },

  get size(): number {
    return engineSessions.size
  },

  /** Test-only: restore a clean process-wide state. */
  resetForTests(): void {
    engineSessions.clear()
    sessionToRun.clear()
    semaphore = new Semaphore(DEFAULT_CONCURRENCY)
  },
}
