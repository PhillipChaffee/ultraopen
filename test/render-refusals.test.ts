import { describe, expect, test } from "bun:test"
import {
  attributeValue,
  renderArgsRefusal,
  renderBothSourceRefusal,
  renderBudgetLine,
  renderCapRefusal,
  renderForeignSessionResumeRefusal,
  renderLaunch,
  renderMissingRunResumeRefusal,
  renderRefusal,
  renderResult,
  renderResumeDecorationRefusal,
  renderResumeRefusal,
  renderScriptPathDecorationRefusal,
  renderSiblingAdvisory,
  renderStopFailure,
  renderStringifiedArgsRefusal,
  renderUnrecordedSessionResumeRefusal,
  stopReasonOf,
  titleAttributeOf,
} from "../src/server/tool/render.js"
import type { WorkflowResult } from "../src/server/tool/workflow.js"

/**
 * Every model-facing refusal and launch render.
 *
 * These are behaviourally load-bearing surfaces: a refusal that silently loses its run id, or a
 * result that hides a failed agent, sends the model to the wrong tool. Each is pinned here so a
 * wording or attribute regression is caught without a live host.
 */

const result = (overrides: Partial<WorkflowResult> = {}): WorkflowResult => ({
  runId: "wf_render0001",
  meta: { name: "audit", description: "Audit the diff" },
  value: { ok: true },
  agentCount: 2,
  nulls: [],
  logs: [],
  outputTokens: 120,
  journal: [],
  childSessionIDs: [],
  ...overrides,
})

describe("result renders", () => {
  test("a successful result carries the value and the run id", () => {
    const text = renderResult(result())
    expect(text).toContain('<result workflow="audit" run="wf_render0001" agents="2">')
    expect(text).toContain('"ok": true')
    expect(text).toContain("<usage")
  })

  test("nulls and logs are separate sections; a resume note names changed args", () => {
    const text = renderResult(
      result({
        nulls: [{ label: "worker", reason: "timeout", detail: "idle" }],
        logs: ["scanning"],
        journal: [{ type: "result", key: "k", scopePath: "", ordinal: 0, label: "worker", status: "ok", outputTokens: 1, replayed: true }],
      }),
      { resumed: 1, argsChanged: true },
    )
    expect(text).toContain("<failures count=\"1\" of=\"2\">")
    expect(text).toContain("<log>")
    expect(text).toContain("args changed since the previous run")
    expect(text).toContain("replayed")
  })

  test("a dry-run note states the run is not queryable", () => {
    expect(renderResult(result(), undefined, [], null, { dry: true })).toContain("not queryable")
  })
})

describe("launch and sibling renders", () => {
  const run = { runId: "wf_sibling01", status: "running" }

  test("a launch names the run and the stop call", () => {
    const text = renderLaunch("audit", "wf_render0001", true, [run], { agents: 12, threshold: 10 }, 5000, "Fix the bug")
    expect(text).toContain('<workflow-launched run="wf_render0001" workflow="audit"')
    expect(text).toContain('title="Fix the bug"')
    expect(text).toContain('workflow({ stop: "wf_render0001" })')
    expect(text).toContain("Sibling runs still live")
    expect(text).toContain("Output-token budget")
  })

  test("the sibling and budget advisories have a no-sibling and uncapped shape", () => {
    expect(renderSiblingAdvisory([])).toBe("")
    expect(renderBudgetLine(null)).toBeUndefined()
    expect(renderBudgetLine(1000)).toContain("1000")
  })

  test("attribute escaping and title presence are shared by every tag", () => {
    expect(attributeValue('a "b" & c')).toBe("a &quot;b&quot; &amp; c")
    expect(titleAttributeOf(undefined)).toBe("")
    expect(titleAttributeOf("  ")).toBe(' title=""')
    expect(titleAttributeOf("Fix")).toBe(' title="Fix"')
  })
})

describe("refusals", () => {
  test("the one-live-run refusal names the run and the status tool", () => {
    const text = renderRefusal({ runId: "wf_live0001", status: "running" })
    expect(text).toContain("<workflow-refused>")
    expect(text).toContain('workflow_status')
    expect(text).toContain("wf_live0001")
  })

  test("the ultracode cap refusal names every live run and the ceiling", () => {
    const text = renderCapRefusal(
      [
        { runId: "wf_live0001", status: "running" },
        { runId: "wf_live0002", status: "pending" },
      ],
      2,
    )
    expect(text).toContain("live-run cap of 2")
    expect(text).toContain("wf_live0001")
    expect(text).toContain("wf_live0002")
  })

  test("resume refusals distinguish malformed, live, foreign, unrecorded and missing runs", () => {
    expect(renderResumeRefusal("bad", undefined)).toContain("not a valid run id")
    expect(renderResumeRefusal("wf_live0001", 42)).toContain("still executing")
    expect(renderForeignSessionResumeRefusal("wf_x", "ses_other")).toContain("different session")
    expect(renderUnrecordedSessionResumeRefusal("wf_x")).toContain("does not record")
    expect(renderMissingRunResumeRefusal("wf_x")).toContain("No run exists")
  })

  test("zero-value decorations are named on args, resume id and script path", () => {
    expect(renderArgsRefusal("null")).toContain("zero-value decoration")
    expect(renderResumeDecorationRefusal("")).toContain("zero-value decoration")
    expect(renderScriptPathDecorationRefusal("undefined")).toContain("zero-value decoration")
  })

  test("both sources and a malformed JSON string are refused with the fix", () => {
    expect(renderBothSourceRefusal()).toContain("scriptPath")
    expect(renderStringifiedArgsRefusal("{bad", "unexpected end")).toContain("unexpected end")
  })

  test("a stop failure names the stop and keeps the resume pointer", () => {
    const text = renderStopFailure("stopped by request", "wf_render0001")
    expect(text).toContain("did not fail on its own")
    expect(text).toContain('id="wf_render0001"')
    const controller = new AbortController()
    expect(stopReasonOf(controller.signal)).toBeUndefined()
    controller.abort("stopped by request")
    expect(stopReasonOf(controller.signal)).toBe("stopped by request")
  })
})
