import { LARGE_RUN_AGENTS } from "../server/script/limits.js"
import type { RpcRunStatus, RpcRunView } from "../rpc.js"

/**
 * Shapes workflow progress for the TUI.
 *
 * The TUI is purely RPC-backed: every surface is fed by the `UltraopenRpc` channel (`listRuns`,
 * pushed `runUpdated` events) and the server half is the only reader of the run directory. This
 * module therefore does zero I/O — no `node:fs`, no `node:path` — so every shape below is a pure
 * function of the RPC payload and a caller-supplied clock.
 *
 * All logic lives here rather than in the JSX component so it can be tested without a terminal.
 */

export interface AgentRow {
  index: number
  label: string
  phase?: string | undefined
  status: "running" | "done" | "failed"
  /** Why the agent failed, from the journal's latest null entry for its key. */
  reason?: string | undefined
  /** The agent's output-token spend, from the progress snapshot. */
  outputTokens?: number | undefined
  /** The agent's child session id, once the spawn created one (#150). */
  sessionID?: string | undefined
}

export interface RunView {
  runId: string
  workflow: string
  sessionID: string
  /** The RPC run status. */
  status?: RpcRunStatus | undefined
  /** Epoch milliseconds the run started, when the source carries it. */
  startedAt?: number | undefined
  phase?: string | undefined
  agents: AgentRow[]
  done: number
  failed: number
  total: number
  /** Seconds since the run started, computed against a caller-supplied clock. */
  elapsedSeconds: number
  logs: string[]
}

export interface InterruptedHint {
  runId: string
  workflow: string
}

/**
 * Shapes one RPC `listRuns` entry for the slot surfaces.
 *
 * `elapsedSeconds` is derived from the caller's clock so every surface reads the same value on
 * one tick; `logs` is empty because the RPC contract carries counts and agents, not history.
 */
export function fromRpcRunView(run: RpcRunView, now: number): RunView {
  const view: RunView = {
    runId: run.runId,
    workflow: run.workflow,
    sessionID: run.sessionID,
    status: run.status,
    startedAt: run.startedAt,
    agents: run.agents.map((agent) => ({ ...agent })),
    done: run.done,
    failed: run.failed,
    total: run.total,
    elapsedSeconds: Math.max(0, Math.round((now - run.startedAt) / 1000)),
    logs: [],
  }
  if (run.phase !== undefined) {view.phase = run.phase}
  return view
}

/** A run the store still shows: `stopping` is live until the server reports a terminal status. */
export function isActiveRunStatus(status: RpcRunStatus | undefined): boolean {
  return status === "running" || status === "stopping"
}

/**
 * Folds one live `runUpdated` event into the store.
 *
 * An active run is inserted or replaced; a terminal one is removed, because the store is a live
 * view, not history. Oldest-first by run id keeps a long run from jumping as newer ones settle.
 */
export function mergeRunUpdate(current: readonly RunView[], updated: RpcRunView, now: number): RunView[] {
  const kept = current.filter((run) => run.runId !== updated.runId)
  const next = isActiveRunStatus(updated.status) ? [...kept, fromRpcRunView(updated, now)] : kept
  return next.toSorted((a, b) => a.runId.localeCompare(b.runId))
}

/**
 * The one settled-entry rule: a fresh payload, with only `elapsedSeconds` preserved from an
 * existing entry of the SAME status. A status transition is a real update and takes fresh elapsed.
 */
function settledView(updated: RpcRunView, now: number, existing: RunView | undefined): RunView {
  const fresh = fromRpcRunView(updated, now)
  return existing !== undefined && existing.status === fresh.status
    ? { ...fresh, elapsedSeconds: existing.elapsedSeconds }
    : fresh
}

/**
 * Folds one settled `runUpdated` event into the `/workflows` panel's recent history.
 *
 * The panel is active/recent, so a run that settles while the user is watching it must move
 * straight from the live list into the history instead of flickering out. An active update is
 * ignored (it belongs in the live store). The first settle freezes `elapsedSeconds`: a finished
 * run's clock must not keep growing while it waits in the history. Newest `startedAt` first,
 * deduplicated by run id, capped at `limit`.
 */
export function recordSettledRun(
  current: readonly RunView[],
  updated: RpcRunView,
  now: number,
  limit = 20,
): RunView[] {
  if (isActiveRunStatus(updated.status)) {return [...current]}
  const existing = current.find((run) => run.runId === updated.runId),
   settled = settledView(updated, now, existing),
   rest = current.filter((run) => run.runId !== updated.runId)
  return [settled, ...rest]
    .toSorted((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.runId.localeCompare(b.runId))
    .slice(0, limit)
}

/**
 * Folds a full `listRuns` snapshot into the panel's recent history.
 *
 * The payload is always the source of truth for agents, counts, phase and status: a run that
 * emitted `stopped` twice must show the SECOND event's rows, not the first event's stale ones. The
 * one preserved field is `elapsedSeconds`, under the same rule as {@link recordSettledRun}.
 */
export function mergeRecentRuns(
  current: readonly RunView[],
  runs: readonly RpcRunView[],
  now: number,
  limit = 20,
): RunView[] {
  const known = new Map(current.map((run) => [run.runId, run]))
  return runs
    .filter((run) => !isActiveRunStatus(run.status))
    .toSorted((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
    .slice(0, limit)
    .map((run) => settledView(run, now, known.get(run.runId)))
}

/**
 * The `/workflows` panel's rows: active runs first, then recent settled ones.
 *
 * The other surfaces are live-only. The panel is documented as active/recent — a run that settles
 * while the user is looking at it must not vanish — so it combines the live store with the capped
 * history snapshot, deduplicating a run that appears in both and never exceeding `limit` rows.
 */
export function combineRuns(
  active: readonly RunView[],
  recent: readonly RunView[],
  limit = 20,
): RunView[] {
  const seen = new Set(active.map((run) => run.runId)),
   combined = [...active]
  for (const run of recent) {
    if (combined.length >= limit) {break}
    if (seen.has(run.runId)) {continue}
    combined.push(run)
    seen.add(run.runId)
  }
  return combined
}

/** `4m12s`, or `12s` under a minute. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) {return `${seconds}s`}
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

/** One-line summary, used by the compact surfaces. */
export function summarize(run: RunView): string {
  const phase = run.phase ? `${run.phase} ` : "",
   failed = run.failed > 0 ? ` · ${run.failed} failed` : "",
   // Advice only: a run this large is worth a look at the fan-out. Same
   // threshold as the server's own warning, so both surfaces agree.
   large = run.total >= LARGE_RUN_AGENTS ? " · large run" : "",
   // The stop request is visible until the server reports the run settled, so the
   // user can tell a click landed instead of pressing Stop again.
   stopping = run.status === "stopping" ? " · stopping" : ""
  return `${run.workflow} · ${phase}${run.done}/${run.total} · ${formatElapsed(run.elapsedSeconds)}${failed}${large}${stopping}`
}

/** Status glyph for an agent row. */
export function glyph(status: AgentRow["status"]): string {
  if (status === "done") {return "✓"}
  if (status === "failed") {return "✗"}
  return "⠋"
}

/**
 * The stop guidance for a session with live runs, shown under the run rows in
 * the sidebar.
 *
 * V2's TUI can stop a run itself (`/workflow-stop`, wired to `rpc.stopRun`), so
 * the direct command leads; the agent-facing `workflow({ stop })` call stays as
 * the transcript-side alternative. ESC never stops a background run. With
 * exactly one live run the line names its id; with several it stays generic.
 */
export function stopHint(runs: readonly RunView[]): string | undefined {
  const first = runs[0]
  if (first === undefined) {return undefined}
  if (runs.length === 1) {
    return `⏹ /workflow-stop ${first.runId} stops it directly — or ask the agent for workflow({ stop: "${first.runId}" }); ESC does not stop background runs.`
  }
  return '⏹ /workflow-stop <runId> stops a run directly — or ask the agent for workflow({ stop: "<runId>" }); ESC does not stop background runs.'
}

/** The hint line: names the run and the way back. */
export function hintLine(hint: InterruptedHint): string {
  return `interrupted: ${hint.workflow} (${hint.runId}) — ask to resume it`
}

/** One agent row's text: glyph, label, and the failure reason when there is one. */
export function agentRowText(agent: AgentRow): string {
  const reason = agent.status === "failed" && agent.reason ? ` — ${agent.reason}` : "",
    tokens = typeof agent.outputTokens === "number" && agent.outputTokens > 0 ? ` · ${formatTokens(agent.outputTokens)}` : "",
    // The child session id where one exists (#150): the human path locates a child by its id
    // or its title in the picker, never by sibling position — so the row states the id itself.
    child = typeof agent.sessionID === "string" && agent.sessionID !== "" ? ` · ${agent.sessionID}` : ""
  return `${glyph(agent.status)} ${agent.label}${reason}${tokens}${child}`
}

/**
 * The strip's compact agent row: glyph, label, child id — nothing else.
 *
 * The strip clips at the input box's right edge, so length is cosmetic, not correctness; the
 * failure reason and token spend stay sidebar-only there because the strip is the
 * always-visible surface and its job is identification, not explanation (#150).
 */
export function stripAgentText(agent: AgentRow): string {
  const child = typeof agent.sessionID === "string" && agent.sessionID !== "" ? ` · ${agent.sessionID}` : ""
  return `${glyph(agent.status)} ${agent.label}${child}`
}

/**
 * One strip line: the run summary plus its compact agent rows.
 *
 * The strip is the always-visible surface, so it carries identification only — the failure
 * reason and token spend stay in the sidebar and the `/workflows` panel (#150).
 */
export function stripLine(run: RunView): string {
  const agents = run.agents.length > 0 ? `  ${run.agents.map((agent) => stripAgentText(agent)).join("   ")}` : ""
  return `ultracode · ${summarize(run)}${agents}`
}

/**
 * The transcript affordances for agent children (#150) in V2: the `/workflows` panel
 * lists every run with clickable child rows, and `/sessions` finds a child by title.
 * Locate by title (`ultraopen · <label>`) or session id, never by position — two
 * different upstream sorts exist for one child list, so neither order is claimable.
 */
export function transcriptHint(): string {
  return "transcripts: /workflows lists runs with clickable child rows; /sessions finds a child by title (ultraopen · <label>)"
}

/** Compact token count: `1.2k`, `345`, `1.1m`. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {return `${Math.round((tokens / 1_000_000) * 10) / 10}m`}
  if (tokens >= 1000) {return `${Math.round((tokens / 1000) * 10) / 10}k`}
  return String(tokens)
}
