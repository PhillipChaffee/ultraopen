import type { Manifest } from "../resume/journal.js"
import { endRun } from "../resume/persist.js"
import { artifactPaths, writeFailure } from "../resume/store.js"
import { registry } from "../singleton.js"
import type { OpencodeClient } from "../types.js"
import { renderResult } from "./render.js"
import type { WorkflowResult } from "./workflow.js"

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

export interface DetachedRun {
  runId: string
  sessionID: string
  status: RunStatus
  startedAt: number
  /**
   * The workflow's meta name, recorded once the launch path has parsed the script. Absent in the
   * window between registration and prepare (and on a run whose parse failed); the per-turn
   * live-run reminder falls back to the run id for that window.
   */
  name?: string
}

const detached = new Map<string, DetachedRun>()

/** runId -> the promise that resolves when the detached task settles. Exposed for tests. */
const settling = new Map<string, Promise<void>>()

/** Resolves when the named detached run has fully settled (or is unknown). */
export function settlePromiseOf(runId: string): Promise<void> {
  return settling.get(runId) ?? Promise.resolve()
}

/**
 * Registers a launch synchronously: the refusal check and this registration
 * are one await-free step, so two tool calls from one session cannot both
 * pass the check before either registers — the check-then-act race. The
 * entry starts `pending` and is promoted (or removed) as the launch proceeds.
 * The stamp fixes the entry's position in start-order queries; passing one
 * explicitly decouples that order from clock granularity.
 */
export function registerPending(runId: string, sessionID: string, startedAt: number = Date.now()): void {
  detached.set(runId, { runId, sessionID, status: "pending", startedAt })
}

/** Promotes a pending entry to running once the permission ask and manifest are in place. */
export function promote(runId: string): void {
  const entry = detached.get(runId)
  if (entry) {entry.status = "running"}
}

/**
 * Records a launch's workflow name once prepare() has parsed the script.
 *
 * Called from the launch path between registration and the permission ask, so even a pending
 * entry carries the name the reminder should show. Unknown ids are ignored: a dropped launch
 * must not resurrect anything.
 */
export function nameRun(runId: string, name: string): void {
  const entry = detached.get(runId)
  if (entry) {entry.name = name}
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

/**
 * Every live entry for the session, oldest start first.
 *
 * Returned entries are copies: registry state is not mutable through them.
 */
export function liveRunsForSession(sessionID: string): DetachedRun[] {
  const live: DetachedRun[] = []
  for (const entry of detached.values()) {
    if (entry.sessionID === sessionID) {live.push({ ...entry })}
  }
  // Stable sort: entries stamped in the same millisecond keep Map insertion
  // order — the stamp and the insertion happen in the same synchronous step,
  // so insertion order is start order.
  return live.toSorted((a, b) => a.startedAt - b.startedAt)
}

/**
 * The session's live entries except the named run — everything left is that
 * run's sibling, oldest start first.
 */
export function siblingRunsForSession(sessionID: string, excludeRunId: string): DetachedRun[] {
  return liveRunsForSession(sessionID).filter((entry) => entry.runId !== excludeRunId)
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

/**
 * Hydration: how a settled detached run's outcome reaches the conversation.
 *
 * The detached contract returns a launch handle, so the result must be DELIVERED. opencode's own
 * background task tool shows the way (`packages/opencode/src/tool/task.ts`, v1.18.31):
 * `injectBackgroundResult` prompts the PARENT session with a `synthetic: true` text part, which
 * the session loop picks up — the prompt service persists the user message before entering the
 * loop, and the loop re-reads messages each step, so a notification landing mid-turn is picked up
 * by the in-flight turn and one landing on an idle session starts a new turn. That injection drops
 * on the busy race (a notification arriving exactly as the turn ends is never read); the idle
 * nudge below covers it.
 *
 * The first `promptAsync` fires unconditionally at settle time — idle vs mid-turn is a server-side
 * distinction the loop resolves either way. The nudge exists ONLY for the turn-end race.
 */

/**
 * The hydration notification's size cap, in characters.
 *
 * The decision is `capped-run-dir` (ticket #7, 2026-09-12): the synthetic message has NO
 * truncation layer — opencode's spill-to-file only wraps plugin TOOL output — so the render is
 * capped here and the full value stays on disk, one pointer line away.
 */
export const HYDRATION_CAP = 4096

/**
 * Cuts text to the cap at a line boundary — never splitting a line, so never splitting a tag.
 *
 * Returns the input unchanged when it already fits. When cutting, whole lines are kept while they
 * fit, and at least one line is always kept (a single over-cap line survives whole rather than
 * degrading to an empty notification). The caller appends the pointer line after the cap.
 */
export function capAtLineBoundary(text: string, cap: number = HYDRATION_CAP): string {
  if (text.length <= cap) {return text}
  const lines = text.split("\n")
  let kept = ""
  for (const line of lines) {
    const candidate = kept === "" ? line : `${kept}\n${line}`
    // A single line longer than the cap is still kept: an empty body is worse than an over-cap one.
    if (candidate.length > cap && kept !== "") {break}
    kept = candidate
  }
  return kept
}

/**
 * The marker every hydration notification opens with, and its recogniser.
 *
 * The idle nudge matches this against the session's last user message, so the wrapper is
 * contract: change it and the nudge goes blind. Tolerant of leading whitespace — transcript
 * round-trips have been known to re-indent.
 */
export const HYDRATION_NOTIFICATION_RE = /^\s*<workflow-(?:completed|failed) run="(?<runId>wf_[a-z0-9]{6,})"/u

export interface HydrationOutcome {
  status: "completed" | "failed"
  name: string
  runId: string
  /** The rendered result (completed) or failure text (failed) to wrap and cap. */
  body: string
}

/**
 * Renders the synthetic notification for one settled run.
 *
 * The body is capped (see {@link HYDRATION_CAP}) and the full artifact is named on the pointer
 * line — `result.json` for a completion, `failure.txt` for a failure. The pointer is appended
 * AFTER the cap on purpose: `renderFailure` trails its run-dir line at the end of its text, so a
 * tail-cut failure would otherwise lose the very path the model needs to recover.
 */
export function renderNotification(outcome: HydrationOutcome): string {
  const tag = outcome.status === "completed" ? "workflow-completed" : "workflow-failed",
    { resultPath, failurePath } = artifactPaths(outcome.runId),
    full = outcome.status === "completed" ? `full result: ${resultPath}` : `full failure: ${failurePath}`
  return [
    `<${tag} run="${outcome.runId}" workflow="${outcome.name}">`,
    capAtLineBoundary(outcome.body),
    `</${tag}>`,
    full,
  ].join("\n")
}

/**
 * One pending hydration notification: a run whose notification may still be unanswered.
 *
 * Tracked so the idle nudge reads messages only for sessions this process actually hydrated —
 * the user's own sessions never pay a listing call on their idle events.
 */
const pending = new Map<string, Map<string, string>>()

/** Run ids this process has already nudged; a session is nudged once per run, ever. */
const nudged = new Set<string>()

/** Delivers the settlement notification to the run's parent session. Never throws. */
export async function hydrateParent(options: {
  client: OpencodeClient
  sessionID: string
  outcome: HydrationOutcome
}): Promise<void> {
  const { client, sessionID, outcome } = options
  try {
    // The session's stored agent rides along: an omitted `agent` would resolve the prompt to the
    // DEFAULT agent (prompt.ts:629-631), not the session's own. Absent or unreadable → omit and
    // accept the default; a hydration under the default agent still beats no hydration.
    const row = await client.session.get({ path: { id: sessionID } }).catch(() => undefined),
      agent = row?.data?.agent,
      text = renderNotification(outcome)
    await client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [{ type: "text", synthetic: true, text }], ...(agent === undefined ? {} : { agent }) },
    })
    // The notification MAY now be unanswered (the turn-end race). Arm the nudge for this session.
    const runs = pending.get(sessionID) ?? new Map<string, string>()
    runs.set(outcome.runId, outcome.name)
    pending.set(sessionID, runs)
  } catch {
    // Fire-and-forget by contract: a rejected hydration must not break the settle protocol that
    // already closed the manifest. The run's outcome is still on disk for workflow_status.
  }
}

/**
 * Delivers one settled run's outcome to its parent session.
 *
 * The index.ts settle paths call this — wiring only. The completion body is the shared
 * `renderResult` render (sibling advisory included, this run excluded); a failure delivers the
 * failure text as rendered for failure.txt. Both are capped and pointed at the full artifact by
 * {@link renderNotification}.
 */
export function deliverOutcome(options: {
  client: OpencodeClient
  sessionID: string
  runId: string
  workflow: string
  /** The completed run's result; its presence picks the completed shape. */
  result?: WorkflowResult
  resume?: { resumed: number; argsChanged: boolean }
  /** The rendered failure text for a failed run. */
  failureText?: string
}): Promise<void> {
  if (options.result !== undefined) {
    return hydrateParent({
      client: options.client,
      sessionID: options.sessionID,
      outcome: {
        status: "completed",
        name: options.workflow,
        runId: options.runId,
        body: renderResult(options.result, options.resume, siblingRunsForSession(options.sessionID, options.runId)),
      },
    })
  }
  return hydrateParent({
    client: options.client,
    sessionID: options.sessionID,
    outcome: { status: "failed", name: options.workflow, runId: options.runId, body: options.failureText ?? "" },
  })
}

/**
 * The idle nudge: re-fire `promptAsync` once when a notification landed unanswered.
 *
 * Called from the plugin `event` hook on `session.idle` (captured at v1.18.31:
 * `packages/schema/src/session-status-event.ts` — `{ type: "session.idle", properties:
 * { sessionID } }`, deprecated upstream but still published from `session/status.ts:43`; the hook
 * itself is `(input: { event: Event }) => Promise<void>`, `packages/plugin/src/index.ts:224`).
 * Race the ticket fixes: the notification persists exactly as the loop finishes its final step,
 * so it is never read — the session idles with our notification as its last word.
 *
 * Once, ever, per run: the re-fire itself is a new user message, so a second idle would find the
 * notification no longer last and re-nudging would only stack duplicates.
 */
export async function onSessionIdle(client: OpencodeClient, sessionID: string): Promise<void> {
  const runs = pending.get(sessionID)
  if (!runs || runs.size === 0) {return}
  try {
    const messages = await client.session.messages({ path: { id: sessionID } })
    const last = messages.data?.at(-1)
    if (!last || last.info.role !== "user") {
      // Answered (an assistant message follows) or the conversation moved on: the race is over.
      pending.delete(sessionID)
      return
    }
    const text = last.parts.map((part) => ("text" in part ? part.text : "")).join("\n"),
      runId = HYDRATION_NOTIFICATION_RE.exec(text)?.groups?.["runId"],
      name = runId === undefined ? undefined : runs.get(runId)
    if (runId === undefined || name === undefined) {
      pending.delete(sessionID)
      return
    }
    if (nudged.has(runId)) {
      pending.delete(sessionID)
      return
    }
    nudged.add(runId)
    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        parts: [{
          type: "text",
          synthetic: true,
          text: `<workflow-nudge run="${runId}" workflow="${name}">The completion notification above is still unanswered — ` +
            `the turn ended as it landed. Read it and act on its result now.</workflow-nudge>`,
        }],
      },
    })
    pending.delete(sessionID)
  } catch {
    // A failed listing or re-fire is retried on the NEXT idle for this session: the pending entry
    // is kept. Never throws — the event hook cannot afford a rejection.
  }
}

/** Test-only: restore clean module state. */
export function resetForTests(): void {
  detached.clear()
  settling.clear()
  pending.clear()
  nudged.clear()
}