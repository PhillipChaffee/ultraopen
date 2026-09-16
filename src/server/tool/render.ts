import { runDir } from "../resume/store.js"
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
 */
export function renderResult(result: WorkflowResult, resume?: { resumed: number; argsChanged: boolean }): string {
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

  const replayed = result.journal.filter((entry) => entry.replayed === true).length
  lines.push(
    "",
    `<usage agents="${result.agentCount}" failed="${result.nulls.length}" replayed="${replayed}" ` +
      `output_tokens="${result.outputTokens}" run_dir="${runDir(result.runId)}" />`,
  )
  return lines.join("\n")
}

/**
 * The launch result of a background run.
 *
 * Deliberately carries NO outcome: the run has not settled, and a second result
 * surface for one run is how a model ends up trusting a stale snapshot. The
 * value arrives through `workflow_status` — and the poll before the turn ends
 * also keeps a one-shot host's turn alive long enough for the run to settle.
 */
export function renderLaunch(workflow: string, runId: string): string {
  return [
    `<workflow-launched run="${runId}" workflow="${workflow}" dir="${runDir(runId)}">`,
    "The run is executing in the background; this message does not contain its outcome.",
    `Poll workflow_status(runId: "${runId}", wait: 120) until the status is not "running" to get the final value or the failure. Before ending your turn, poll until the run settles.`,
    "</workflow-launched>",
  ].join("\n")
}

/** Names the run that already occupies this session, so the model polls instead of relaunching. */
export function renderRefusal(active: { runId: string; status: string }): string {
  return [
    "<workflow-refused>",
    `This session already has a workflow run in flight (${active.status}): run id ${active.runId}, directory ${runDir(active.runId)}.`,
    `Poll workflow_status(runId: "${active.runId}", wait: 120) for its progress and final value instead of launching another.`,
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

/** The status tool's report, for the model. Same uncapped stance as renderResult. */
export function renderStatus(report: StatusReport): string {
  const lines = [
    `<workflow-status run="${report.runId}" status="${report.status}" dir="${report.dir}">`,
    `agents total=${report.agents.total} running=${report.agents.running} done=${report.agents.done} failed=${report.agents.failed}`,
    `output_tokens=${report.outputTokens}`,
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
 * `title` and `description` are accepted and IGNORED, exactly as the spec specifies — a model
 * trained on Claude Code passes them, and rejecting them would surface as a validation error
 * instead of the documented silent ignore.
 */
export function workflowArgsSchema(): Record<string, unknown> {
  return {
    script: { type: "string", description: "The workflow script. Must begin with `export const meta = {...}`." },
    scriptPath: { type: "string", description: "Path to a persisted script. Takes precedence over `script`." },
    args: { description: "Value exposed to the script as the global `args`. Pass real JSON, not a JSON string." },
    resumeFromRunId: {
      type: "string",
      description: "Resume a previous run from this directory's data: unchanged agent calls replay from its journal instantly, and the first changed call onward runs live. Refused while the source run is still executing.",
    },
    dryRun: { type: "boolean", description: "Run the script with agent() stubbed out, for zero tokens. Always waits for the result." },
    background: {
      type: "boolean",
      description: "Launch detached and return the run id at once (the default), or wait for the final result. dryRun always waits.",
    },
    title: { type: "string", description: "Ignored." },
    description: { type: "string", description: "Ignored." },
  }
}

export function statusArgsSchema(): Record<string, unknown> {
  return {
    runId: { type: "string", description: "The run id from the workflow launch result." },
    wait: { type: "number", description: "Seconds to wait for the run to settle before returning (max 300). Prefer one long wait over many short polls." },
  }
}
