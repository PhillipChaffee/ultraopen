import { describe, expect, test } from "bun:test"
import type { Rpc } from "@opencode/plugin/rpc"
import {
  AGENT_STATUSES,
  RUN_STATUSES,
  STOP_OUTCOMES,
  UltraopenRpc,
  isRecord,
  parseListRunsInput,
  parseListRunsOutput,
  parseRunUpdatedData,
  parseStopRunInput,
  parseStopRunOutput,
} from "../src/rpc.js"
import type { RpcRunStatus, RpcRunView } from "../src/rpc.js"

// Compile-time guarantee: UltraopenRpc is a valid V2 PortableDefinition for ctx.rpc.register & client.rpc.
const _assertPortable: Rpc.PortableDefinition = UltraopenRpc
void _assertPortable

describe("RPC status tuples", () => {
  test("each exported tuple is the single source the unions and schemas derive from", () => {
    expect(AGENT_STATUSES).toEqual(["running", "done", "failed"])
    expect(RUN_STATUSES).toEqual(["running", "stopping", "completed", "stopped", "failed", "interrupted"])
    expect(STOP_OUTCOMES).toEqual(["stopped", "already_completed", "already_stopped"])
    expect(UltraopenRpc.methods.listRuns.output.properties.runs.items.properties.status.enum).toEqual([
      ...RUN_STATUSES,
    ])
    expect(
      UltraopenRpc.methods.listRuns.output.properties.runs.items.properties.agents.items.properties.status.enum,
    ).toEqual([...AGENT_STATUSES])
    expect(UltraopenRpc.methods.stopRun.output.properties.outcome.enum).toEqual([...STOP_OUTCOMES])
  })

  test("isRecord narrows plain objects only", () => {
    expect(isRecord({ runId: "wf_1" })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord([])).toBe(false)
    expect(isRecord("wf_1")).toBe(false)
    expect(isRecord(42)).toBe(false)
  })
})

describe("UltraopenRpc", () => {
  test("declares required id, methods input/output, and object event schema", () => {
    expect(UltraopenRpc.id).toBe("ultraopen")
    expect(UltraopenRpc.methods.listRuns.input.type).toBe("object")
    expect(UltraopenRpc.methods.listRuns.output.type).toBe("object")
    expect(UltraopenRpc.methods.stopRun.input.type).toBe("object")
    expect(UltraopenRpc.methods.stopRun.output.type).toBe("object")
    expect(UltraopenRpc.methods.stopRun.errors?.not_found.type).toBe("object")
    expect(UltraopenRpc.methods.stopRun.errors?.stop_failed.type).toBe("object")
    expect(UltraopenRpc.events.runUpdated.schema.type).toBe("object")
  })

  test("parsers narrow valid payloads and reject malformed values safely", () => {
    expect(parseListRunsInput({ sessionID: "ses_1", includeHints: true })).toEqual({
      sessionID: "ses_1",
      includeHints: true,
    })
    expect(parseListRunsInput("bad")).toEqual({})
    expect(parseStopRunInput({ runId: "wf_1" })).toEqual({ runId: "wf_1" })
    expect(() => parseStopRunInput({})).toThrow()
    expect(parseStopRunOutput({ runId: "wf_1", outcome: "already_completed" })).toEqual({
      runId: "wf_1",
      outcome: "already_completed",
    })
    const sample = {
      runId: "wf_1",
      workflow: "audit",
      sessionID: "ses_1",
      status: "stopping",
      agents: [{ index: 0, label: "a", status: "running", sessionID: "ses_c1" }],
      done: 0,
      failed: 0,
      total: 1,
      startedAt: 1000,
    }
    expect(parseListRunsOutput({ runs: [sample], hints: [{ runId: "wf_0", workflow: "old" }] }).runs).toHaveLength(1)
    expect(parseRunUpdatedData({ run: sample })?.run.status).toBe("stopping")
    expect(parseRunUpdatedData({ run: null })).toBeUndefined()
  })

  test("parseListRunsInput handles empty objects, wrong-typed fields, null, and arrays", () => {
    expect(parseListRunsInput({})).toEqual({})
    expect(parseListRunsInput(null)).toEqual({})
    expect(parseListRunsInput(undefined)).toEqual({})
    expect(parseListRunsInput(["ses_1"])).toEqual({})
    expect(parseListRunsInput({ sessionID: 42, includeHints: "true" })).toEqual({})
    expect(parseListRunsInput({ includeHints: false })).toEqual({ includeHints: false })
  })

  test("parseStopRunInput rejects non-objects and invalid runId values", () => {
    expect(() => parseStopRunInput(null)).toThrow()
    expect(() => parseStopRunInput(["wf_1"])).toThrow()
    expect(() => parseStopRunInput("wf_1")).toThrow()
    expect(() => parseStopRunInput({ runId: "" })).toThrow()
    expect(() => parseStopRunInput({ runId: 123 })).toThrow()
  })

  test("parseStopRunOutput accepts all outcomes and rejects malformed payloads", () => {
    expect(parseStopRunOutput({ runId: "wf_1", outcome: "stopped" })).toEqual({
      runId: "wf_1",
      outcome: "stopped",
    })
    expect(parseStopRunOutput({ runId: "wf_2", outcome: "already_stopped" })).toEqual({
      runId: "wf_2",
      outcome: "already_stopped",
    })
    expect(() => parseStopRunOutput(null)).toThrow()
    expect(() => parseStopRunOutput([])).toThrow()
    expect(() => parseStopRunOutput({})).toThrow()
    expect(() => parseStopRunOutput({ runId: "", outcome: "stopped" })).toThrow()
    expect(() => parseStopRunOutput({ runId: "wf_1", outcome: "cancelled" })).toThrow()
  })

  test("parseListRunsOutput preserves optional fields, all statuses, and filters malformed entries", () => {
    const statuses: RpcRunStatus[] = ["running", "stopping", "completed", "stopped", "failed", "interrupted"]
    const fullRuns: RpcRunView[] = statuses.map((status, i) => ({
      runId: `wf_${i}`,
      workflow: "review",
      sessionID: "ses_main",
      status,
      phase: "verify",
      agents: [
        {
          index: 0,
          label: "checker",
          phase: "p1",
          status: "done",
          outputTokens: 150,
          sessionID: "ses_c0",
        },
        {
          index: 1,
          label: "fixer",
          status: "failed",
          reason: "timed out",
        },
      ],
      done: 1,
      failed: 1,
      total: 2,
      startedAt: 1_700_000_000_000 + i,
    }))

    const parsed = parseListRunsOutput({
      runs: [
        ...fullRuns,
        null,
        { runId: "", workflow: "x", sessionID: "s", status: "running", agents: [], done: 0, failed: 0, total: 0, startedAt: 1 },
        { runId: "wf_bad_status", workflow: "x", sessionID: "s", status: "bogus", agents: [], done: 0, failed: 0, total: 0, startedAt: 1 },
        { runId: "wf_bad_agents", workflow: "x", sessionID: "s", status: "running", agents: "nope", done: 0, failed: 0, total: 0, startedAt: 1 },
        { runId: "wf_bad_counts", workflow: "x", sessionID: "s", status: "running", agents: [], done: Number.NaN, failed: 0, total: 0, startedAt: 1 },
      ],
      hints: [
        { runId: "wf_old", workflow: "audit" },
        null,
        { runId: "", workflow: "audit" },
        { runId: "wf_no_name", workflow: 99 },
      ],
    })

    expect(parsed.runs).toEqual(fullRuns)
    expect(parsed.hints).toEqual([{ runId: "wf_old", workflow: "audit" }])
  })

  test("parseListRunsOutput degrades safely on non-object inputs, omitted hints, and bad agent rows", () => {
    expect(parseListRunsOutput(null)).toEqual({ runs: [] })
    expect(parseListRunsOutput("oops")).toEqual({ runs: [] })
    expect(parseListRunsOutput([])).toEqual({ runs: [] })
    expect(parseListRunsOutput({ runs: "not-an-array", hints: "not-an-array" })).toEqual({ runs: [] })

    const parsed = parseListRunsOutput({
      runs: [
        {
          runId: "wf_mixed",
          workflow: "mix",
          sessionID: "ses_1",
          status: "running",
          phase: 123,
          agents: [
            null,
            { index: -1, label: "neg", status: "running" },
            { index: 0, label: 42, status: "running" },
            { index: 0, label: "bad-status", status: "unknown" },
            {
              index: 0,
              label: "good",
              status: "running",
              phase: 1,
              reason: 2,
              outputTokens: -5,
              sessionID: 3,
            },
          ],
          done: 0,
          failed: 0,
          total: 1,
          startedAt: 500,
        },
      ],
    })

    expect(parsed).toEqual({
      runs: [
        {
          runId: "wf_mixed",
          workflow: "mix",
          sessionID: "ses_1",
          status: "running",
          agents: [{ index: 0, label: "good", status: "running" }],
          done: 0,
          failed: 0,
          total: 1,
          startedAt: 500,
        },
      ],
    })
    expect("hints" in parsed).toBe(false)
  })

  test("parseRunUpdatedData rejects non-objects and invalid run payloads", () => {
    expect(parseRunUpdatedData(null)).toBeUndefined()
    expect(parseRunUpdatedData(undefined)).toBeUndefined()
    expect(parseRunUpdatedData("bad")).toBeUndefined()
    expect(parseRunUpdatedData([])).toBeUndefined()
    expect(parseRunUpdatedData({})).toBeUndefined()
    expect(parseRunUpdatedData({ run: { runId: "wf_1" } })).toBeUndefined()
  })
})
