import { describe, expect, test } from "bun:test"
import { renderCapRefusal, renderLaunch, renderRefusal, renderResult, renderSiblingAdvisory } from "../src/server/tool/render.js"
import type { WorkflowResult } from "../src/server/tool/workflow.js"

/** A minimal settled result; the advisory pins concern the siblings, not the payload. */
const result = (over: Partial<WorkflowResult> = {}): WorkflowResult => ({
  runId: "wf_render01",
  meta: { name: "demo", description: "a demo workflow" },
  value: "the-value",
  agentCount: 1,
  nulls: [],
  logs: [],
  outputTokens: 0,
  journal: [],
  childSessionIDs: [],
  ...over,
})

const siblings = [
  { runId: "wf_sibl001", status: "running" },
  { runId: "wf_sibl002", status: "pending" },
]

describe("renderSiblingAdvisory", () => {
  test("no siblings renders nothing — appending it must add no line", () => {
    expect(renderSiblingAdvisory([])).toBe("")
  })

  test("names each sibling's run id and status on one line, oldest first", () => {
    const advisory = renderSiblingAdvisory(siblings)
    expect(advisory).toContain("wf_sibl001 (running)")
    expect(advisory).toContain("wf_sibl002 (pending)")
    // Oldest first: the caller orders the list, the render preserves it.
    expect(advisory.indexOf("wf_sibl001")).toBeLessThan(advisory.indexOf("wf_sibl002"))
    // One line: no newline inside the advisory itself.
    expect(advisory.includes("\n")).toBe(false)
    expect(advisory).toContain("Sibling runs still live in this session, oldest first:")
  })
})

describe("renderCapRefusal", () => {
  test("names every live run id and status, oldest first", () => {
    const refused = renderCapRefusal(siblings, 2)
    expect(refused).toContain("<workflow-refused>")
    expect(refused).toContain("wf_sibl001 (running)")
    expect(refused).toContain("wf_sibl002 (pending)")
    // Oldest first: the caller orders the list, the render preserves it.
    expect(refused.indexOf("wf_sibl001")).toBeLessThan(refused.indexOf("wf_sibl002"))
    expect(refused).toContain("</workflow-refused>")
  })

  test("states the cap and the live count so the model knows what to wait for", () => {
    const refused = renderCapRefusal(siblings, 2)
    expect(refused).toContain("2 concurrent workflow runs")
    expect(refused).toContain("cap of 2")
    // The way back: poll the live runs, not relaunch.
    expect(refused).toContain("workflow_status")
  })

  test("a cap of 1 with one live run still names the run (distinct from the plain refusal)", () => {
    const refused = renderCapRefusal([{ runId: "wf_solo0001", status: "running" }], 1)
    expect(refused).toContain("wf_solo0001 (running)")
    expect(refused).toContain("cap of 1")
  })
})

describe("renderRefusal", () => {
  // The non-ultracode refusal is preserved verbatim; this pins the text the
  // conditional gate must not change.
  test("names the one active run and its status", () => {
    const refused = renderRefusal({ runId: "wf_solo0002", status: "running" })
    expect(refused).toContain("<workflow-refused>")
    expect(refused).toContain("already has a workflow run in flight (running): run id wf_solo0002")
    expect(refused).toContain('Poll workflow_status(runId: "wf_solo0002", wait: 120)')
  })
})

describe("renderLaunch", () => {
  test("the one-shot hold-the-turn text is unchanged without siblings", () => {
    const launched = renderLaunch("demo", "wf_solo0001", false)
    expect(launched).toContain(
      'Poll workflow_status(runId: "wf_solo0001", wait: 120) until the status is not "running" to get the final value or the failure. Before ending your turn, poll until the run settles.',
    )
    expect(launched).not.toContain("Sibling")
  })

  test("with siblings, the one-shot text instructs polling EACH live run id before ending the turn", () => {
    const launched = renderLaunch("demo", "wf_solo0002", false, siblings)
    expect(launched).toContain("Before ending your turn, poll workflow_status for each live run id in this message until all runs settle.")
    // The advisory line sits inside the launch envelope and names every sibling.
    expect(launched).toContain("Sibling runs still live in this session, oldest first: wf_sibl001 (running), wf_sibl002 (pending).")
    expect(launched.indexOf("Sibling runs")).toBeLessThan(launched.indexOf("</workflow-launched>"))
  })

  test("the long-lived text is unchanged by siblings; the advisory still names them", () => {
    const launched = renderLaunch("demo", "wf_solo0003", true, siblings)
    expect(launched).toContain("This host keeps the process alive, so the run settles on its own — end your turn and let it work.")
    expect(launched).not.toContain("each live run id")
    expect(launched).toContain("Sibling runs still live in this session, oldest first: wf_sibl001 (running), wf_sibl002 (pending).")
  })

  test("no siblings appends nothing", () => {
    const launched = renderLaunch("demo", "wf_solo0004", false, [])
    expect(launched).not.toContain("Sibling")
    expect(launched).not.toMatch(/\n\n/u)
  })
})

describe("renderResult", () => {
  test("the blocking result carries the same sibling advisory after the usage line", () => {
    const rendered = renderResult(result(), undefined, siblings)
    expect(rendered).toContain("Sibling runs still live in this session, oldest first: wf_sibl001 (running), wf_sibl002 (pending).")
    expect(rendered.indexOf("<usage")).toBeLessThan(rendered.indexOf("Sibling runs"))
  })

  test("no siblings appends nothing", () => {
    const rendered = renderResult(result(), undefined, [])
    expect(rendered).not.toContain("Sibling")
    const bare = renderResult(result())
    expect(rendered).toBe(bare)
  })
})