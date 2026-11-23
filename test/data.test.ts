import { describe, expect, test } from "bun:test"
import {
  agentRowText,
  combineRuns,
  formatTokens,
  fromRpcRunView,
  mergeRecentRuns,
  mergeRunUpdate,
  recordSettledRun,
  stopHint,
  stripLine,
  summarize,
  transcriptHint,
} from "../src/tui/data.js"
import type { RunView } from "../src/tui/data.js"
import type { RpcRunView } from "../src/rpc.js"

const runView = (runId: string): RunView => ({
  runId,
  workflow: "demo",
  sessionID: "ses_1",
  agents: [],
  done: 1,
  failed: 0,
  total: 1,
  elapsedSeconds: 5,
  logs: [],
})

const rpcRun = (overrides: Partial<RpcRunView> = {}): RpcRunView => ({
  runId: "wf_rpc0001",
  workflow: "demo",
  sessionID: "ses_1",
  status: "running",
  agents: [],
  done: 1,
  failed: 0,
  total: 1,
  startedAt: 1000,
  ...overrides,
})

describe("fromRpcRunView — the RPC snapshot becomes a display view", () => {
  test("copies identity, status, and start time and derives elapsed from the caller's clock", () => {
    const view = fromRpcRunView(
      rpcRun({
        phase: "Verify",
        agents: [{ index: 0, label: "a", status: "running", sessionID: "ses_child_0" }],
        done: 1,
        total: 2,
        startedAt: 10_000,
      }),
      70_000,
    )

    expect(view.runId).toBe("wf_rpc0001")
    expect(view.workflow).toBe("demo")
    expect(view.sessionID).toBe("ses_1")
    expect(view.status).toBe("running")
    expect(view.startedAt).toBe(10_000)
    expect(view.phase).toBe("Verify")
    expect(view.agents).toEqual([{ index: 0, label: "a", status: "running", sessionID: "ses_child_0" }])
    expect(view.done).toBe(1)
    expect(view.total).toBe(2)
    expect(view.elapsedSeconds).toBe(60)
    expect(view.logs).toEqual([])
  })

  test("a clock behind the start time never yields negative elapsed", () => {
    expect(fromRpcRunView(rpcRun({ startedAt: 5000 }), 1000).elapsedSeconds).toBe(0)
  })

  test("a stopping run keeps its status", () => {
    expect(fromRpcRunView(rpcRun({ status: "stopping" }), 2000).status).toBe("stopping")
  })
})

describe("mergeRunUpdate — live runUpdated events land in the store", () => {
  test("inserts a run that was not in the store", () => {
    const next = mergeRunUpdate([], rpcRun({ runId: "wf_b" }), 2000)
    expect(next.map((run) => run.runId)).toEqual(["wf_b"])
  })

  test("replaces an existing run and moves it to stopping", () => {
    const current = fromRpcRunView(rpcRun({ runId: "wf_a" }), 1000)
    const next = mergeRunUpdate([current], rpcRun({ runId: "wf_a", status: "stopping" }), 3000)
    expect(next).toHaveLength(1)
    expect(next[0]?.status).toBe("stopping")
    expect(next[0]?.elapsedSeconds).toBe(2)
  })

  test.each(["completed", "stopped", "failed", "interrupted"] as const)(
    "removes a run that settles as %p",
    (status) => {
      const current = fromRpcRunView(rpcRun({ runId: "wf_a" }), 1000)
      expect(mergeRunUpdate([current], rpcRun({ runId: "wf_a", status }), 2000)).toEqual([])
    },
  )

  test("a terminal update for an unknown run changes nothing", () => {
    const current = fromRpcRunView(rpcRun({ runId: "wf_a" }), 1000)
    expect(mergeRunUpdate([current], rpcRun({ runId: "wf_z", status: "completed" }), 2000)).toEqual([current])
  })

  test("keeps unrelated runs and sorts oldest-first by run id", () => {
    const current = [
      fromRpcRunView(rpcRun({ runId: "wf_c" }), 1000),
      fromRpcRunView(rpcRun({ runId: "wf_a" }), 1000),
    ]
    const next = mergeRunUpdate(current, rpcRun({ runId: "wf_b" }), 2000)
    expect(next.map((run) => run.runId)).toEqual(["wf_a", "wf_b", "wf_c"])
  })
})

describe("recordSettledRun — settled runs keep their place in the panel history", () => {
  test("recordSettledRun inserts a newly settled run at the front of recent without flickering or exceeding the cap", () => {
    const older = fromRpcRunView(rpcRun({ runId: "wf_old", status: "completed", startedAt: 1000 }), 2000)
    const settled = rpcRun({ runId: "wf_new", status: "completed", startedAt: 3000 })
    const next = recordSettledRun([older], settled, 5000, 20)
    expect(next.map((r) => r.runId)).toEqual(["wf_new", "wf_old"])
    expect(next[0]?.elapsedSeconds).toBe(2)
    expect(recordSettledRun(next, rpcRun({ runId: "wf_live", status: "running" }), 9000)).toEqual(next)
    expect(recordSettledRun(next, settled, 90_000)[0]?.elapsedSeconds).toBe(2)
    expect(recordSettledRun(next, rpcRun({ runId: "wf_third", status: "completed", startedAt: 4000 }), 5000, 2).map((r) => r.runId)).toEqual(["wf_third", "wf_new"])
  })

  test("a repeated settled update refreshes rows and reason while keeping the frozen elapsed time", () => {
    const first = recordSettledRun(
       [],
       rpcRun({
         runId: "wf_repeat",
         status: "stopped",
         startedAt: 1000,
         done: 0,
         agents: [{ index: 0, label: "a", status: "running" }],
       }),
       5000,
      ),
      second = recordSettledRun(
       first,
       rpcRun({
         runId: "wf_repeat",
         status: "stopped",
         startedAt: 1000,
         failed: 1,
         done: 0,
         agents: [{ index: 0, label: "a", status: "failed", reason: "api-error" }],
       }),
       90_000,
      )

    // Same status = same settled moment: the clock stays frozen at 4s, not 89s.
    expect(first[0]?.elapsedSeconds).toBe(4)
    expect(second[0]?.elapsedSeconds).toBe(4)
    // Everything else is the SECOND payload, not the first event's stale rows.
    expect(second[0]?.agents).toEqual([{ index: 0, label: "a", status: "failed", reason: "api-error" }])
    expect(second[0]?.failed).toBe(1)
    expect(second[0]?.status).toBe("stopped")
  })

  test("a status transition updates status, agents and elapsed", () => {
    const first = recordSettledRun(
       [],
       rpcRun({
         runId: "wf_transition",
         status: "interrupted",
         startedAt: 1000,
         agents: [],
         done: 0,
       }),
       5000,
      ),
      second = recordSettledRun(
       first,
       rpcRun({
         runId: "wf_transition",
         status: "completed",
         startedAt: 1000,
         done: 1,
         agents: [{ index: 0, label: "b", status: "done" }],
       }),
       20_000,
      )

    expect(first[0]?.status).toBe("interrupted")
    expect(second[0]?.status).toBe("completed")
    expect(second[0]?.agents).toEqual([{ index: 0, label: "b", status: "done" }])
    expect(second[0]?.done).toBe(1)
    // A real transition is not the frozen settle: the fresh clock applies.
    expect(second[0]?.elapsedSeconds).toBe(19)
  })
})

describe("mergeRecentRuns — a poll snapshot replaces history under the same freeze rule", () => {
  test("refreshes rows and counts while preserving elapsed only for an unchanged status", () => {
    const current = fromRpcRunView(
       rpcRun({
         runId: "wf_poll",
         status: "completed",
         startedAt: 1000,
         agents: [{ index: 0, label: "old", status: "done" }],
       }),
       5000,
      ),
      next = mergeRecentRuns(
       [current],
       [
         rpcRun({
           runId: "wf_poll",
           status: "completed",
           startedAt: 1000,
           agents: [{ index: 0, label: "new", status: "done" }],
         }),
       ],
       90_000,
      )

    expect(next[0]?.agents).toEqual([{ index: 0, label: "new", status: "done" }])
    expect(next[0]?.elapsedSeconds).toBe(4)
  })

  test("active runs are dropped from history and the newest are capped", () => {
    const runs = [
       rpcRun({ runId: "wf_a", status: "completed", startedAt: 1000 }),
       rpcRun({ runId: "wf_b", status: "running", startedAt: 2000 }),
       rpcRun({ runId: "wf_c", status: "failed", startedAt: 3000 }),
     ]
    expect(mergeRecentRuns([], runs, 5000).map((run) => run.runId)).toEqual(["wf_c", "wf_a"])
    expect(mergeRecentRuns([], runs, 5000, 1).map((run) => run.runId)).toEqual(["wf_c"])
  })
})

describe("combineRuns — the /workflows panel keeps recent settled runs", () => {
  test("active runs come first, then recent runs in the given order", () => {
    const active = [runView("wf_live")],
     recent = [runView("wf_recent_new"), runView("wf_recent_old")]
    expect(combineRuns(active, recent).map((run) => run.runId)).toEqual([
      "wf_live",
      "wf_recent_new",
      "wf_recent_old",
    ])
  })

  test("a run present in both lists appears once, as the active entry", () => {
    const live: RunView = { ...runView("wf_both"), status: "running", phase: "live" },
     settled: RunView = { ...runView("wf_both"), status: "completed", phase: "settled" },
     combined = combineRuns([live], [settled, runView("wf_other")])
    expect(combined.map((run) => run.runId)).toEqual(["wf_both", "wf_other"])
    expect(combined[0]?.phase).toBe("live")
  })

  test("the total is capped while every active run survives the cap", () => {
    const active = [runView("wf_a1"), runView("wf_a2"), runView("wf_a3")],
     recent = Array.from({ length: 5 }, (_unused, index) => runView(`wf_r${index}`)),
     combined = combineRuns(active, recent, 4)
    expect(combined).toHaveLength(4)
    expect(combined.slice(0, 3).map((run) => run.runId)).toEqual(["wf_a1", "wf_a2", "wf_a3"])
    expect(combined[3]?.runId).toBe("wf_r0")
  })

  test("the default cap is 20 rows", () => {
    const recent = Array.from({ length: 30 }, (_unused, index) => runView(`wf_${String(index).padStart(2, "0")}`))
    expect(combineRuns([], recent)).toHaveLength(20)
  })
})

describe("summarize — one line for every compact surface", () => {
  test("flags a run the user asked to stop", () => {
    const stopping: RunView = { ...runView("wf_stop"), status: "stopping" }
    expect(summarize(stopping)).toBe("demo · 1/1 · 5s · stopping")
  })

  test("a running run carries no stopping marker", () => {
    expect(summarize({ ...runView("wf_run"), status: "running" })).toBe("demo · 1/1 · 5s")
  })
})

describe("stopHint — the sidebar's stop guidance", () => {
  test("no live runs means no hint", () => {
    expect(stopHint([])).toBeUndefined()
  })

  test("a single live run names its id for both the direct command and the tool call", () => {
    expect(stopHint([runView("wf_hint0001")])).toBe(
      '⏹ /workflow-stop wf_hint0001 stops it directly — or ask the agent for workflow({ stop: "wf_hint0001" }); ESC does not stop background runs.',
    )
  })

  test("several live runs keep the line generic instead of stacking ids", () => {
    const hint = stopHint([runView("wf_hint0001"), runView("wf_hint0002")])
    expect(hint).toContain("/workflow-stop <runId>")
    expect(hint).toContain('workflow({ stop: "<runId>" })')
    expect(hint).toContain("ESC does not stop background runs")
  })
})

describe("transcriptHint — V2 navigation affordances", () => {
  test("names the /workflows panel, its clickable rows, and the /sessions title lookup", () => {
    const hint = transcriptHint()
    expect(hint).toContain("/workflows")
    expect(hint).toContain("clickable")
    expect(hint).toContain("/sessions")
    expect(hint).toContain("ultraopen · <label>")
    expect(hint).not.toContain("leader+down")
  })
})

describe("stripLine — the always-visible strip stays compact", () => {
  test("carries the run summary and child ids but never the reason or token spend", () => {
    const run: RunView = {
      ...runView("wf_strip"),
      agents: [
        { index: 0, label: "a", status: "failed", reason: "api-error", outputTokens: 999, sessionID: "ses_child_0" },
        { index: 1, label: "b", status: "running" },
      ],
    }
    const line = stripLine(run)
    expect(line).toBe("ultracode · demo · 1/1 · 5s  ✗ a · ses_child_0   ⠋ b")
    expect(line).not.toContain("api-error")
    expect(line).not.toContain("999")
  })
})

describe("token counts in agent rows", () => {
  test("a settled agent's tokens render compactly", () => {
    expect(formatTokens(4321)).toBe("4.3k")
    expect(formatTokens(345)).toBe("345")
    expect(formatTokens(1_250_000)).toBe("1.3m")
    expect(agentRowText({ index: 0, label: "a", status: "done", outputTokens: 4321 })).toBe("✓ a · 4.3k")
    expect(agentRowText({ index: 0, label: "a", status: "running" })).toBe("⠋ a")
  })

  test("zero-token agents carry no token suffix", () => {
    expect(agentRowText({ index: 0, label: "a", status: "done", outputTokens: 0 })).toBe("✓ a")
  })
})

