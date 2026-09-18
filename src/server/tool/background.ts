import type { Manifest } from "../resume/journal.js"
import { endRun } from "../resume/persist.js"
import { writeFailure } from "../resume/store.js"
import { registry } from "../singleton.js"

/**
 * Which launch contract the host process can honor, decided from the process shape.
 *
 * The evidence is live-captured argv from the installed opencode 1.18.31 binary (reproduced
 * verbatim in the tests):
 *   - `opencode run` runs its server in-process and exits unconditionally after the turn
 *     (packages/opencode/src/index.ts, the `finally` block) — an unsettled detached run dies with
 *     the process. argv: ["bun", "/$bunfs/root/src/index.js", "run", "say hi"].
 *   - the TUI boots its server inside a Bun worker thread whose argv is the worker file alone,
 *     because a worker does not inherit the parent's argv:
 *     ["bun", "/$bunfs/root/src/cli/tui/worker.js"].
 *   - `opencode serve`, `opencode web` and `opencode acp` call `Server.listen` and live until
 *     killed; `--mini` is the interactive REPL.
 *
 * The failure directions are not symmetric. Freeing the turn in a process that is about to exit
 * loses the run mid-flight (journal and resume survive, the work does not); pinning the turn in a
 * long-lived host merely blocks the chat. Unknown shapes therefore keep the pinned contract.
 */
export function isLongLivedHost(argv: readonly string[] = process.argv): boolean {
  const tokens = argv.slice(1)
  // The `run` subcommand and any driver built on it: the process exits after the
  // turn, so the model must hold the turn by polling until the run settles.
  if (tokens.includes("run")) {return false}
  return tokens.some(
    (token) =>
      token === "serve" ||
      token === "web" ||
      token === "acp" ||
      token === "--mini" ||
      // The TUI's worker thread: plugins never load in the TUI parent process.
      /tui[\\/]worker\.(?<ext>js|ts)$/u.test(token),
  )
}

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

/**
 * Drops a settled run's entry, whatever status it holds.
 *
 * The blocking contract keeps its gate entry from registration until its settle
 * protocol completes; that removal cannot be status-guarded (dropPending
 * deletes pending entries only), or a settle would strand the session gate and
 * the resume refusal forever.
 */
export function dropSettled(runId: string): void {
  detached.delete(runId)
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
  manifest: Manifest | undefined
  task: () => Promise<void>
  /**
   * A settle the CALLER owns — it can join the flush chain, which this module
   * cannot see. The degraded outcome is recorded even though the escaping
   * rejection means the caller's own failure path broke. Optional: the module
   * itself already persists the degraded record.
   */
  onEscapedRejection?: ((error: unknown) => Promise<void>) | undefined
  /** Renders the error for failure.txt when the caller's settle cannot. */
  renderFailure: (error: unknown, source?: string, runId?: string) => string
}): Promise<void> {
  promote(options.runId)
  const promise = (async () => {
    try {
      await options.task()
    } catch (error) {
      // The task was contractually self-capturing; an escaping rejection means
      // its own failure path broke. Persist the degraded record HERE (this
      // module cannot settle the flush chain), and let the caller's callback
      // add whatever more it can.
      await writeFailure(options.runId, options.renderFailure(error)).catch(() => undefined)
      await endRun(options.manifest, { status: "failed", entries: [], value: null, childSessionIDs: [] })
      await options.onEscapedRejection?.(error)
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