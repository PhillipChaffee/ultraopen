import type { Manifest } from "../resume/journal.js"
import { registry } from "../singleton.js"

/**
 * The detached-run layer: everything that lets a run outlive its tool call.
 *
 * State lives at MODULE level for the same reason `singleton.ts` does: opencode
 * instantiates the plugin once per directory, so factory-closure state is not
 * shared. The registry here owns LAUNCH-GATING state only — which runs are
 * pending or live, per session — while disk (manifest/journal/progress) remains
 * the single source of truth for what a run did. Settled entries are dropped
 * immediately: the status tool reads disk, so keeping them would only invite
 * stale answers.
 *
 * There is deliberately no keepalive timer. `opencode run` calls
 * `process.exit()` in its CLI `finally`, which no timer can hold, and the TUI
 * and `opencode serve` persist on their own — see
 * tasks/async-runs/notes/host-lifecycle-facts.md.
 */

type RunStatus = "pending" | "running"

interface DetachedRun {
  runId: string
  sessionID: string
  status: RunStatus
  startedAt: number
}

const detached = new Map<string, DetachedRun>()

/** runId -> the promise that resolves when the detached task settles. Exposed for tests. */
const settling = new Map<string, Promise<void>>()

/** Resolves when the named detached run has fully settled (or is unknown). */
export function settlePromiseOf(runId: string): Promise<void> {
  return settling.get(runId) ?? Promise.resolve()
}

/**
 * Registers a launch synchronously, BEFORE the first await.
 *
 * Two tool calls from one session in the same tick would otherwise both pass
 * the refusal check before either registers — the check-then-act race. The
 * entry starts `pending` and is promoted (or removed) as the launch proceeds.
 */
export function registerPending(runId: string, sessionID: string): void {
  detached.set(runId, { runId, sessionID, status: "pending", startedAt: Date.now() })
}

/** Promotes a pending entry to running once the permission ask and manifest are in place. */
export function promote(runId: string): void {
  const entry = detached.get(runId)
  if (entry) {entry.status = "running"}
}

/** Drops a pending entry — the launch failed before the run went live. */
export function dropPending(runId: string): void {
  const entry = detached.get(runId)
  if (entry && entry.status === "pending") {detached.delete(runId)}
}

/** The run this session currently has pending or live, if any. */
export function activeRunForSession(sessionID: string): DetachedRun | undefined {
  for (const entry of detached.values()) {
    if (entry.sessionID === sessionID) {return entry}
  }
  return undefined
}

/** True while the run is registered as pending or running, in THIS process. */
export function isLive(runId: string): boolean {
  const entry = detached.get(runId)
  return entry !== undefined && (entry.status === "pending" || entry.status === "running")
}

/**
 * True when the manifest names an owner that is still running, in any process.
 *
 * `isLive` only sees this process; a run launched by another boot (a second
 * server, an earlier session) must also be refused a resume while its pid is
 * alive, or two Run instances would write one run directory.
 */
export function isLiveAnywhere(manifest: Manifest, observerBootId: string): boolean {
  if (manifest.status !== "running") {return false}
  if (manifest.bootId === observerBootId) {return isLive(manifest.runId)}
  return isProcessAlive(manifest.pid)
}

export async function runDetached(options: {
  runId: string
  task: () => Promise<void>
  onEscapedRejection: (error: unknown) => Promise<void>
}): Promise<void> {
  promote(options.runId)
  const promise = (async () => {
    try {
      await options.task()
    } catch (error) {
      // The task was contractually self-capturing; an escaping rejection means
      // its own failure path broke. The caller's callback — which can settle the
      // flush chain — records the degraded failed state.
      await options.onEscapedRejection(error)
    } finally {
      detached.delete(options.runId)
      settling.delete(options.runId)
      registry.forgetRun(options.runId)
    }
  })()
  settling.set(options.runId, promise)
  await promise
}

/** Injectable for tests; a live pid makes `isLiveAnywhere` trust the manifest. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Test-only: restore clean module state. */
export function resetForTests(): void {
  detached.clear()
  settling.clear()
}