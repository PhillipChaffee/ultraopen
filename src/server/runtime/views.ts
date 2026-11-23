import type { RpcAgentRow, RpcRunStatus, RpcRunView } from "../../rpc.js"
import type { Manifest } from "../resume/journal.js"
import type { AgentProgress, ProgressSnapshot } from "../resume/progress.js"
import type { LiveRunRecord } from "./coordinator.js"

/**
 * The ONE mapping from each run surface onto the RPC view the TUI renders.
 *
 * Three sources describe one run — the in-memory live record, its progress snapshot, and its
 * manifest — and the same view shape must come out of all three. Keeping the translation here
 * rather than in each caller is what stops the surfaces drifting: the settlement path, the stop
 * path and the RPC listing all import these functions, so a field added to `RpcRunView` (or a
 * status rename) has exactly one place to change.
 */

/** A manifest's terminal status as the RPC vocabulary names it. */
export function manifestStatusToRpc(status: Manifest["status"]): RpcRunStatus {
  if (status === "completed") {return "completed"}
  if (status === "cancelled") {return "stopped"}
  if (status === "failed") {return "failed"}
  if (status === "orphaned") {return "interrupted"}
  return "running"
}

/**
 * The status a settled run reports: the STANDING manifest wins over the settle's own claim.
 *
 * A cancel that won the manifest while the settle was still unwinding must read `stopped`, not the
 * `failed` the engine saw, so this takes the re-read manifest status and only falls back to the
 * settle outcome when the manifest is unreadable.
 */
export function terminalRpcStatus(
  status: Manifest["status"] | undefined,
  fallback: "completed" | "failed",
): RpcRunStatus {
  // A missing OR still-running manifest means the disk has no terminal word to offer; the
  // settle's own outcome is the only honest answer left.
  return status === undefined || status === "running" ? fallback : manifestStatusToRpc(status)
}

/**
 * One snapshot agent as an RPC row, counts derived from the same pass.
 *
 * `reason` is copied only when present, so a live row that never failed stays byte-identical to
 * the shape the rpc schema's `additionalProperties: false` accepts without the optional field.
 */
function agentRowsOf(agents: readonly AgentProgress[]): { rows: RpcAgentRow[]; done: number; failed: number } {
  const rows: RpcAgentRow[] = []
  let done = 0
  let failed = 0
  for (const agent of agents) {
    rows.push({
      index: agent.index,
      label: agent.label,
      status: agent.status,
      ...(agent.phase === undefined ? {} : { phase: agent.phase }),
      ...(agent.reason === undefined ? {} : { reason: agent.reason }),
      ...(agent.outputTokens === undefined ? {} : { outputTokens: agent.outputTokens }),
      ...(agent.sessionID === undefined ? {} : { sessionID: agent.sessionID }),
    })
    if (agent.status === "done") {done++}
    if (agent.status === "failed") {failed++}
  }
  return { rows, done, failed }
}

/** The view of a run from its progress snapshot, with the caller-supplied lifecycle status. */
export function rpcViewFromProgress(snapshot: ProgressSnapshot, status: RpcRunStatus): RpcRunView {
  const { rows, done, failed } = agentRowsOf(snapshot.agents)
  return {
    runId: snapshot.runId,
    workflow: snapshot.workflow,
    sessionID: snapshot.sessionID,
    status,
    ...(snapshot.phase === undefined ? {} : { phase: snapshot.phase }),
    agents: rows,
    done,
    failed,
    total: rows.length,
    startedAt: snapshot.startedAt,
  }
}

/**
 * The view of a run still held by this process.
 *
 * `latestView` is the last view this run emitted, so it is the freshest description of its agent
 * rows. When the caller asserts a status (the stop path says `stopping`, then `stopped`) that
 * status wins; when it does not, the view's own status stands — a settled run's terminal view must
 * never be relabelled `running` just because it is still registered for one more tick.
 */
export function rpcViewFromLive(run: LiveRunRecord, status?: RpcRunStatus): RpcRunView {
  if (run.latestView !== undefined) {
    return status === undefined ? { ...run.latestView } : { ...run.latestView, status }
  }
  return {
    runId: run.runId,
    workflow: run.name ?? "workflow",
    sessionID: run.sessionID,
    status: status ?? (run.status === "stopping" ? "stopping" : "running"),
    agents: [],
    done: 0,
    failed: 0,
    total: 0,
    startedAt: run.startedAt,
  }
}

/** True for a runtime agent record: the fields the RPC view reads, all present and well-typed. */
function isAgentProgress(value: unknown): value is AgentProgress {
  if (typeof value !== "object" || value === null) {return false}
  const agent = value as Partial<AgentProgress>
  return typeof agent.index === "number" &&
    typeof agent.label === "string" &&
    (agent.status === "running" || agent.status === "done" || agent.status === "failed")
}

/**
 * The view of a run read from disk: the manifest supplies identity and the standing status, the
 * snapshot the rows.
 *
 * `progress.json` is disposable and may be partial, hand-edited or written by an older version, so
 * every field is validated before use: the manifest's `runId`/`sessionID`/`startedAt` are
 * authoritative, a missing workflow falls back to the generic label, and only well-formed agent
 * records become rows. A torn file must never take down a `listRuns` poll.
 */
export function rpcViewFromManifest(manifest: Manifest, progress: ProgressSnapshot | undefined): RpcRunView {
  const snapshot: Partial<ProgressSnapshot> | undefined = progress,
   // In-flight disk reads report the stop consistently with the live surfaces: the manifest stays
   // `running` until the children unwind, and the snapshot is the only place the request landed.
   status = manifest.status === "running" && snapshot?.status === "stopping"
     ? "stopping"
     : manifestStatusToRpc(manifest.status),
   workflow = typeof snapshot?.workflow === "string" ? snapshot.workflow : "workflow",
   startedAt = typeof snapshot?.startedAt === "number" && Number.isFinite(snapshot.startedAt)
     ? snapshot.startedAt
     : manifest.startedAt,
   phase = typeof snapshot?.phase === "string" ? snapshot.phase : undefined,
   agents = Array.isArray(snapshot?.agents) ? snapshot.agents.filter(isAgentProgress) : [],
   { rows, done, failed } = agentRowsOf(agents)
  return {
    runId: manifest.runId,
    workflow,
    sessionID: manifest.sessionID,
    status,
    ...(phase === undefined ? {} : { phase }),
    agents: rows,
    done,
    failed,
    total: rows.length,
    startedAt,
  }
}
