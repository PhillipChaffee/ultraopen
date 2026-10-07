import { runDir } from "../resume/store.js"
import { LARGE_RUN_AGENTS } from "../script/limits.js"
import { stringifiedArgsMessage, stringifiedArgsSuggestion } from "./args-transport.js"
import type { WorkflowResult } from "./workflow.js"
import type { StatusReport } from "./status.js"

/**
 * Everything the two tools SAY to the model: the blocking result, the launch
 * result, the refusals, the status report, and the argument schemas.
 *
 * These are behaviourally load-bearing prompt surfaces, not documentation —
 * extracting them keeps the tool wiring in index.ts readable and gives the
 * shapes one home to evolve.
 */

/**
 * Renders the blocking contract's result for the model.
 *
 * Returns the FULL text with the summary first, deliberately uncapped: opencode already pipes
 * plugin tool output through its truncation layer, which spills the whole value to a file the
 * agent is pre-authorised to read and hands back the path. Pre-capping here would stop that spill
 * from ever firing and silently lose the tail.
 *
 * TWO delivery paths read this text. The blocking tool output keeps the uncapped stance above —
 * opencode's truncation layer owns the size. The detached contract's hydration notification
 * (tool/background.ts) wraps this same render in its synthetic message, which has NO truncation
 * layer, so THAT path caps the render at a line boundary and appends a pointer to the run's full
 * `result.json` — the cap lives there, never here.
 *
 * The sibling advisory (when the session still holds live runs) trails the usage line: the
 * blocking call held the turn only for its own run, so the model must know what else is live.
 *
 * The per-run budget (when `budgetTokens` is set) is stated beside the spend it caps, and the
 * advisory carries the combined math — the cure for silent multi-run overspend is visibility,
 * not prevention (#32). Uncapped stays silent: no budget line when the option is unset.
 */
export function renderResult(
  result: WorkflowResult,
  resume?: { resumed: number; argsChanged: boolean },
  siblings: readonly RunSummary[] = [],
  budgetTokens?: number | null | undefined,
): string {
  const lines = [
    `<result workflow="${result.meta.name}" run="${result.runId}" agents="${result.agentCount}">`,
    typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2),
    "</result>",
  ]

  // Never let partial coverage read as full coverage.
  if (result.nulls.length > 0) {
    lines.push(
      "",
      `<failures count="${result.nulls.length}" of="${result.agentCount}">`,
      ...result.nulls.map((entry) => `  ${entry.label}: ${entry.reason}${entry.detail ? ` — ${entry.detail}` : ""}`),
      "</failures>",
    )
  }

  if (result.logs.length > 0) {
    lines.push("", "<log>", ...result.logs.map((line) => `  ${line}`), "</log>")
  }

  // A replayed run must never read as a fresh one — the whole point of recording replays is that
  // a cached empty and a fresh empty look identical otherwise.
  if (resume?.argsChanged === true) {
    lines.push("", "<resume note=\"args changed since the previous run, so nothing was replayed\" />")
  }

  // Advice, never a stop: a run this large is worth a second look at the
  // fan-out, and the note names the constants' threshold.
  if (result.agentCount >= LARGE_RUN_AGENTS) {
    lines.push("", `<large-run agents="${result.agentCount}" threshold="${LARGE_RUN_AGENTS}" />`)
  }

  const replayed = result.journal.filter((entry) => entry.replayed === true).length
  lines.push(
    "",
    `<usage agents="${result.agentCount}" failed="${result.nulls.length}" replayed="${replayed}" ` +
      `output_tokens="${result.outputTokens}" run_dir="${runDir(result.runId)}" />`,
  )
  const budgetLine = renderBudgetLine(budgetTokens)
  if (budgetLine !== undefined) {lines.push(budgetLine)}
  // The run is settled at render time — the session's live runs are exactly the siblings.
  appendAdvisory(lines, siblings, budgetMath(budgetTokens, siblings.length))
  return lines.join("\n")
}

/**
 * The launch result of a background run.
 *
 * Deliberately carries NO outcome: the run has not settled, and a second result
 * surface for one run is how a model ends up trusting a stale snapshot. The
 * value arrives through `workflow_status` — and the poll before the turn ends
 * also keeps a one-shot host's turn alive long enough for the run to settle.
 *
 * The contract sentence is host-aware: in a long-lived host the turn is told to
 * end (the run survives it), in a one-shot host it is told to hold by polling
 * (the run dies with the process otherwise). The variant follows the HOST, not
 * the `background` flag — a forced-background launch in a one-shot host still
 * needs the hold-the-turn text or the process exits out from under the run.
 * When the session holds sibling live runs, the one-shot hold names them all:
 * polling only this run would still end the turn while the siblings execute.
 *
 * The launch-time projection, when available, follows the opening tag: the
 * projected fan-out always shows, and at or above the threshold it renders as
 * a large-workflow advisory — the one place a model sees run size BEFORE
 * agents are scheduled, so it is the model's chance to double-check the script.
 * The per-run budget statement (when `budgetTokens` is set) rides beside it:
 * cost joins size as a pre-flight consideration.
 *
 * The launch's `title` metadata (#142), when the launch passed one, rides in
 * the opening tag right after the workflow name it qualifies — the name stays
 * primary, the title is additional. Absent on an untitled launch, whose tag is
 * byte-identical to the pre-#142 shape.
 */
export function renderLaunch(
  workflow: string,
  runId: string,
  longLived: boolean,
  siblings: readonly RunSummary[] = [],
  projection?: { agents: number; threshold: number } | undefined,
  budgetTokens?: number | null | undefined,
  title?: string | undefined,
): string {
  let projectionLine: string | undefined
  if (projection === undefined) {
    projectionLine = undefined
  } else if (projection.agents >= projection.threshold) {
    projectionLine =
      `Large workflow: ~${projection.agents} agents projected (threshold ${projection.threshold}) — ` +
      `check the script's fan-out if this is larger than intended.`
  } else {
    projectionLine = `~${projection.agents} agents projected at launch.`
  }
  const budgetLine = renderBudgetLine(budgetTokens)
  const titleAttribute = titleAttributeOf(title)
  const lines = [
    `<workflow-launched run="${runId}" workflow="${workflow}"${titleAttribute} dir="${runDir(runId)}">`,
    // First body line, ahead of the contract sentence: size is what the model should
    // reconsider before the fan-out is scheduled.
    ...(projectionLine === undefined ? [] : [projectionLine]),
    ...(budgetLine === undefined ? [] : [budgetLine]),
    "The run is executing in the background; this message does not contain its outcome.",
    // Sets user-facing expectations: the host's cancel cascade (ESC) cannot
    // reach plugin background runs — the stop argument is the only off switch.
    `Interrupting the turn (ESC) does not stop this run; to stop it, call workflow({ stop: "${runId}" }).`,
  ]
  if (longLived) {
    lines.push(
      `This host keeps the process alive, so the run settles on its own — end your turn and let it work. ` +
        `Poll workflow_status(runId: "${runId}", wait: 120) when the user asks about the run, or when the ` +
        `current task cannot finish without the run's value.`,
    )
  } else if (siblings.length === 0) {
    lines.push(
      `Poll workflow_status(runId: "${runId}", wait: 120) until the status is not "running" to get the final value or the failure. Before ending your turn, poll until the run settles.`,
    )
  } else {
    const hold = siblings.length === 0
      ? "Before ending your turn, poll until the run settles."
      : "Before ending your turn, poll workflow_status for each live run id in this message until all runs settle."
    lines.push(
      `Poll workflow_status(runId: "${runId}", wait: 120) until the status is not "running" to get the final value or the failure. ${hold}`,
    )
  }
  // The run just launched and is live, so the combined math counts it: siblings + this one.
  appendAdvisory(lines, siblings, budgetMath(budgetTokens, siblings.length + 1))
  lines.push("</workflow-launched>")
  return lines.join("\n")
}

/** A run as the model-facing renders name it: its id and status. */
export interface RunSummary {
  runId: string
  status: string
}

/** The per-run ceiling statement; null (uncapped) stays silent — the surface is unchanged. */
export function renderBudgetLine(budgetTokens: number | null | undefined): string | undefined {
  return typeof budgetTokens === "number" ? `Output-token budget: ${budgetTokens} per run.` : undefined
}

/**
 * Renders one string as a double-quoted tag attribute value.
 *
 * Titles are free model text (#142); a raw quote inside the value would end the
 * attribute early and malform the tag the model reads. The value is escaped for
 * DISPLAY only — the manifest records the string verbatim. `&` goes first so the
 * escape sequence itself is not double-escaped.
 */
export function attributeValue(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
}

/**
 * The ` title="..."` attribute for a render tag, empty when the title is absent.
 *
 * The manifests are JSON files a human can edit, so a non-string value read off disk
 * degrades to untitled instead of throwing inside a render the settle protocol or the
 * status tool already committed to. Line breaks are flattened for display — the same
 * free-text shape rule the reminder's oneLine applies — so the tag stays one line; the
 * manifest records the title verbatim.
 */
export function titleAttributeOf(title: string | undefined): string {
  return typeof title === "string" ? ` title="${attributeValue(oneLineTitle(title))}"` : ""
}

/** Flattens a free-text title onto one line for a tag attribute (#142). */
function oneLineTitle(title: string): string {
  return title.replaceAll(/\s+/gu, " ").trim()
}

/** The combined-spend math the sibling advisory appends when the per-run budget is set. */
interface BudgetMath {
  /** The per-run output-token ceiling: the plugin's `budgetTokens`, one per run. */
  ceiling: number
  /**
   * Live runs in this session for the combined math. A surface's own run counts
   * only while it is live: +1 on the launch result, the siblings alone on the
   * settled blocking result.
   */
  liveRuns: number
}

function budgetMath(budgetTokens: number | null | undefined, liveRuns: number): BudgetMath | undefined {
  return typeof budgetTokens === "number" ? { ceiling: budgetTokens, liveRuns } : undefined
}

/**
 * One advisory line naming every sibling live run, oldest first.
 *
 * Empty input renders nothing: an append must add no line, not an empty one.
 * The renderer is naming only — the poll instructions live in the contract
 * sentences around it, which differ per contract.
 *
 * When the per-run budget is set, the line also carries the combined math:
 * every live run holds the same ceiling, so N live runs can spend N × ceiling
 * — the math made un-missable rather than prevented (#32).
 */
export function renderSiblingAdvisory(siblings: readonly RunSummary[], budget?: BudgetMath | undefined): string {
  if (siblings.length === 0) {return ""}
  const named = siblings.map((sibling) => `${sibling.runId} (${sibling.status})`).join(", ")
  const math = budget === undefined
    ? ""
    : ` With ${budget.liveRuns} live run${budget.liveRuns === 1 ? "" : "s"} in this session at ${budget.ceiling} output tokens each, combined ceiling ${budget.liveRuns * budget.ceiling}.`
  return `Sibling runs still live in this session, oldest first: ${named}.${math}`
}

function appendAdvisory(lines: string[], siblings: readonly RunSummary[], budget?: BudgetMath | undefined): void {
  const advisory = renderSiblingAdvisory(siblings, budget)
  if (advisory !== "") {lines.push(advisory)}
}

/** Names the run that already occupies this session, so the model polls instead of relaunching. */
export function renderRefusal(active: RunSummary): string {
  return [
    "<workflow-refused>",
    `This session already has a workflow run in flight (${active.status}): run id ${active.runId}, directory ${runDir(active.runId)}.`,
    `Poll workflow_status(runId: "${active.runId}", wait: 120) for its progress and final value instead of launching another.`,
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A launch at an ultracode session's live-run cap.
 *
 * Every live run is named (run id + status, oldest first): the model must know
 * what is in flight and pick one to wait on, since finishing any run frees a
 * slot. The plain one-live-run refusal above stays the non-ultracode refusal —
 * the two texts differ because the cap refusal names several runs and states
 * the ceiling.
 */
export function renderCapRefusal(runs: readonly RunSummary[], cap: number): string {
  const named = runs.map((run) => `${run.runId} (${run.status})`).join(", ")
  return [
    "<workflow-refused>",
    `This session already holds ${runs.length} concurrent workflow runs — at the live-run cap of ${cap}: ${named}.`,
    `Poll workflow_status for each run id until at least one settles, then launch again.`,
    "</workflow-refused>",
  ].join("\n")
}

/** A resume whose id is malformed or whose source run is still owned by a live process. */
export function renderResumeRefusal(runId: string, pid: number | undefined): string {
  const reason =
    pid === undefined
      ? `"${runId}" is not a valid run id. Pass the id exactly as the launch result reported it.`
      : `Run ${runId} is still executing (started by process ${pid}); resuming it now would run two engines against one journal.`
  return [
    "<workflow-refused>",
    reason,
    pid === undefined
      ? "Pass a run id of the form wf_xxxxxx from a launch result."
      : `Poll workflow_status(runId: "${runId}", wait: 120) and wait for it to settle, then resume.`,
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A resume whose source run belongs to a DIFFERENT session (#147).
 *
 * Resume is same-session by design — a foreign journal would replay results produced for
 * another conversation's context. The refusal names the situation so the caller can tell it
 * apart from a successful empty resume; the silence was the bug, re-running every agent at
 * full price with no note.
 */
export function renderForeignSessionResumeRefusal(runId: string, sessionID: string): string {
  return [
    "<workflow-refused>",
    `Run ${runId} was launched in a different session (${sessionID}); its journal cannot be replayed here — resume is same-session by design, because results produced for another conversation's context are not valid answers in this one.`,
    "Launch the workflow fresh in this session, or resume it from the session that launched it.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A resume whose source run's manifest records no session at all.
 *
 * The Manifest schema REQUIRES sessionID and every manifest writer since the first run store
 * has recorded it, so a manifest without one is corrupt — not a pre-upgrade format. Resume is
 * same-session by design, and provenance that cannot be read cannot be verified: refused with
 * the truthful message rather than the foreign-session render, whose message would name
 * "(undefined)" as the session that owns the run — a session it never saw.
 */
export function renderUnrecordedSessionResumeRefusal(runId: string): string {
  return [
    "<workflow-refused>",
    `Run ${runId}'s manifest does not record the session that launched it, so it cannot be verified as same-session — resume is same-session by design, because results produced for another conversation's context are not valid answers in this one.`,
    "Launch the workflow fresh in this session.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A resume whose id is well-formed but whose run directory is gone (#131): a
 * typo'd id or a pruned run. Refused before the ask — the silent alternative
 * replayed nothing and read as a fresh launch at full price. The hint points at
 * the status tool's run listing, where valid ids come from.
 */
export function renderMissingRunResumeRefusal(runId: string): string {
  return [
    "<workflow-refused>",
    `No run exists with id "${runId}" — the id may be mistyped or its run directory has been pruned.`,
    "Poll workflow_status for the ids of recent runs, and resume one of those; a launch result also reports its run id.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A launch, resume, or dryRun whose `args` carries a model-emitted zero-value decoration.
 *
 * The strings "", "null" and "undefined" are the weather: models emit them for an absent
 * optional field. Refused rather than normalized — the identity contract is that the script
 * sees exactly what was passed, and a decorated resume hashes differently from its source
 * baseline, so the argsChanged guard would refuse the replay and the string would run live.
 * The refusal names the fix so the model self-corrects for the rest of the session.
 */
export function renderArgsRefusal(value: string): string {
  return [
    "<workflow-refused>",
    `The \`args\` field was passed as the string "${value}" — a zero-value decoration ("", "null", or "undefined"), not a real argument. The script would receive that string as its global \`args\`, and a resume decorated this way can no longer replay its source run.`,
    "To pass no arguments, omit the `args` field entirely; otherwise pass real JSON.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A launch or dryRun whose `resumeFromRunId` carries a model-emitted zero-value
 * decoration (#132).
 *
 * The empty string is falsy, so without this refusal it silently skips the resume gate
 * and reads as a fresh launch; "null" and "undefined" reach the gate only to be refused
 * as malformed ids, never named as the decoration they are. Refused loudly instead —
 * nothing was resumed, and the caller who means a fresh launch omits the field.
 */
export function renderResumeDecorationRefusal(value: string): string {
  return [
    "<workflow-refused>",
    `The \`resumeFromRunId\` field was passed as the string "${value}" — a zero-value decoration ("", "null", or "undefined"), not a run id, so no resume was attempted.`,
    "To launch fresh, omit the `resumeFromRunId` field entirely; otherwise pass the run id exactly as a launch result reported it.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A launch or dryRun whose `scriptPath` carries a model-emitted zero-value decoration (#141).
 *
 * A decorated scriptPath is a truthy string, so it wins the source precedence
 * (scriptPath > script > name) and reaches script resolution, failing there with a bare
 * filesystem error (observed: ENOENT open 'null') that never names the decoration it is.
 * Refused loudly at the boundary instead — the same treatment `args` and `resumeFromRunId`
 * get, with the same placement pins: after the stop dispatch, before the launch gate and
 * the permission ask. A caller who means the inline script omits the field.
 */
export function renderScriptPathDecorationRefusal(value: string): string {
  return [
    "<workflow-refused>",
    `The \`scriptPath\` field was passed as the string "${value}" — a zero-value decoration ("", "null", or "undefined"), not a script path, so no script was resolved.`,
    "To run the script passed in `script`, omit the `scriptPath` field entirely; otherwise pass a real path to a persisted script.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A launch whose `script` and `scriptPath` arrive together (#143).
 *
 * The resolution precedence is scriptPath > script, so the inline script — usually the
 * fuller source text — was silently discarded, and a wrong or stale path killed it with
 * a bare filesystem error naming neither field. Refused loudly at the boundary instead,
 * with the same placement pins as the other boundary guards: after the stop dispatch,
 * before the launch gate and the permission ask. The precedence itself is unchanged;
 * the refusal replaces only the silent discard.
 */
export function renderBothSourceRefusal(): string {
  return [
    "<workflow-refused>",
    "Both `script` and `scriptPath` were supplied. The resolution precedence is scriptPath > script, so the inline `script` would be discarded and only the file would run.",
    "Pass one source: keep `script` (omit `scriptPath`), or keep `scriptPath` and delete the `script` field.",
    "</workflow-refused>",
  ].join("\n")
}

/**
 * A launch, resume, or dryRun whose `args` field is a string that looks like JSON but does not
 * parse (#78).
 *
 * The sibling of the zero-value refusal above, for content-bearing payloads: the refusal names
 * what was received (previewed, not dumped) and the reason, and states the transport contract —
 * a JSON string that parses to an object or array is hydrated automatically, so only an
 * unrepairable one is refused.
 */
export function renderStringifiedArgsRefusal(raw: string, reason: string): string {
  return [
    "<workflow-refused>",
    stringifiedArgsMessage(raw, reason),
    `${stringifiedArgsSuggestion} A JSON string that parses to an object or array is hydrated automatically and the repair is logged; this one could not be repaired, so the script would have received the raw string.`,
    "</workflow-refused>",
  ].join("\n")
}

/** The status tool's report, for the model. Same uncapped stance as renderResult. */
export function renderStatus(report: StatusReport): string {
  // The launch's title metadata (#142) rides the tag, appended after the existing
  // attributes so the untitled shape is byte-identical to the pre-#142 render.
  const titleAttribute = titleAttributeOf(report.title)
  const lines = [
    `<workflow-status run="${report.runId}" status="${report.status}" dir="${report.dir}"${titleAttribute}>`,
    `agents total=${report.agents.total} running=${report.agents.running} done=${report.agents.done} failed=${report.agents.failed}`,
    `output_tokens=${report.outputTokens}`,
    // Capped runs surface the ceiling and the live spend against it; uncapped (total
    // null — unset, or a run whose snapshot never reached disk) stays silent.
    ...(report.budget.total === null ? [] : [`budget total=${report.budget.total} spent=${report.budget.spent}`]),
    `phases: ${report.phases.length > 0 ? report.phases.join(", ") : "(none)"}`,
  ]
  if (report.phase !== undefined) {lines.push(`current phase: ${report.phase}`)}
  if (report.status === "completed") {
    lines.push("", typeof report.value === "string" ? report.value : JSON.stringify(report.value, null, 2))
  }
  if (report.failure !== undefined) {
    lines.push("", `<failure dir="${report.failure.dir}">`, report.failure.message, "</failure>")
  }
  if (report.logs.length > 0) {
    lines.push("", "<log>", ...report.logs.map((line) => `  ${line}`), "</log>")
  }
  lines.push("</workflow-status>")
  return lines.join("\n")
}

/**
 * The tools' argument schemas, as plain JSON-Schema-ish records.
 *
 * `title` and `description` are honored as run metadata (#142) — a model trained on Claude Code
 * passes them on most launches (89% of the sampled corpus), and the fields are recorded and
 * surfaced rather than fought. The fields stay ACCEPTED either way: rejecting them would surface
 * as a schema validation error instead of the honored metadata.
 */
export function workflowArgsSchema(): Record<string, unknown> {
  return {
    script: { type: "string", description: "The workflow script. Must begin with `export const meta = {...}`." },
    scriptPath: {
      type: "string",
      description: "Path to a persisted script. Passing both `script` and `scriptPath` is refused — keep one source: `script` inline, or `scriptPath` and delete the `script` field. The strings \"\", \"null\", and \"undefined\" are refused as zero-value decorations — omit the field to run the script passed in `script`.",
    },
    args: {
      description:
        "Value exposed to the script as the global `args`. Pass real JSON, not a JSON string: a string that parses to an object or array is hydrated to that value (and the repair is logged), one that looks like JSON but fails to parse is refused, and any other string stays a scalar. The strings \"\", \"null\", and \"undefined\" are refused as zero-value decorations — omit the field for no arguments.",
    },
    resumeFromRunId: {
      type: "string",
      description: "Resume a previous run from this directory's data: unchanged agent calls replay from its journal instantly, and the first changed call onward runs live. Refused while the source run is still executing. The strings \"\", \"null\", and \"undefined\" are refused as zero-value decorations — omit the field for a fresh launch.",
    },
    dryRun: { type: "boolean", description: "Run the script with agent() stubbed out, for zero tokens. Always waits for the result." },
    background: {
      type: "boolean",
      description: "Launch detached and return the run id at once (the default), or wait for the final result. dryRun always waits.",
    },
    stop: {
      type: "string",
      description:
        "Stop the live workflow run with this id: its subagents are aborted and the run is marked cancelled. Unknown or already-finished run ids return a clear error.",
    },
    title: {
      type: "string",
      description:
        "Optional run title, recorded on the run's manifest and shown on a background launch's result, the live-run reminder, status reports, and settle notifications. The workflow name stays primary.",
    },
    description: {
      type: "string",
      description: "Optional run description, recorded on the run's manifest.",
    },
  }
}

export function statusArgsSchema(): Record<string, unknown> {
  return {
    runId: { type: "string", description: "The run id from the workflow launch result." },
    wait: { type: "number", description: "Seconds to wait for the run to settle before returning (max 300). Prefer one long wait over many short polls." },
  }
}

/**
 * The run-level stop reason on an aborted signal, when the abort named a requester.
 *
 * A stop aborts with a string reason — the tool stop's bare STOP_ABORT_REASON, the control
 * channel's provenance-suffixed one (#134). A parent-turn interrupt aborts without one;
 * that distinction is what keeps interrupts out of the stop's failure surface.
 */
export function stopReasonOf(signal: AbortSignal | undefined): string | undefined {
  return signal?.aborted === true && typeof signal.reason === "string" && signal.reason.trim() !== ""
    ? signal.reason
    : undefined
}

/**
 * The failure surface for a stopped run: the stop, named (#135).
 *
 * A stopped run's unwind usually carries the SCRIPT's own error text — the aborted agent's
 * `null` interpolated into the script's template string, so the failure surface read like
 * the script failed on its own and pointed the debugging direction away from the stop.
 * When the signal carries a stop reason, the surface states the stop and quotes the reason
 * verbatim, provenance included, and keeps the run-dir pointer renderFailure attaches —
 * the resume affordance is the one thing a stopped run's reader still needs.
 */
export function renderStopFailure(reason: string, runId: string): string {
  const body = [
    "The run was stopped — it did not fail on its own.",
    `Reason: ${reason}.`,
    "Completed agents remain on disk for a later resume.",
  ].join("\n")
  return `${body}\n\n<run id="${runId}" dir="${runDir(runId)}" />`
}
