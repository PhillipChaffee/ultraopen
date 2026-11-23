import { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared OpenCode V2 RPC contract between ultraopen's server plugin and TUI plugin.
 *
 * All method input/output/error schemas and event schemas use plain Draft 2020-12 JSON Schema
 * (zero Zod or Effect dependency) because `@opencode/schema@2.3.2` and `@opencode/core@2.3.2`
 * require explicit `input`, `output`, and `events` schemas at both compile time and runtime.
 *
 * The status and outcome vocabularies below are single-source tuples: each one derives its TS
 * union, its JSON Schema `enum`, and its runtime type guard, so the three can never drift.
 */

export const AGENT_STATUSES = ["running", "done", "failed"] as const

export const RUN_STATUSES = ["running", "stopping", "completed", "stopped", "failed", "interrupted"] as const

export const STOP_OUTCOMES = ["stopped", "already_completed", "already_stopped"] as const

export type RpcAgentStatus = (typeof AGENT_STATUSES)[number]

export type RpcRunStatus = (typeof RUN_STATUSES)[number]

export type RpcStopOutcome = (typeof STOP_OUTCOMES)[number]

export interface RpcAgentRow {
  index: number
  label: string
  phase?: string | undefined
  status: RpcAgentStatus
  reason?: string | undefined
  outputTokens?: number | undefined
  sessionID?: string | undefined
}

export interface RpcRunView {
  runId: string
  workflow: string
  sessionID: string
  status: RpcRunStatus
  phase?: string | undefined
  agents: RpcAgentRow[]
  done: number
  failed: number
  total: number
  startedAt: number
}

export interface RpcInterruptedHint {
  runId: string
  workflow: string
}

export interface ListRunsInput {
  sessionID?: string | undefined
  includeHints?: boolean | undefined
}

export interface ListRunsOutput {
  runs: RpcRunView[]
  hints?: RpcInterruptedHint[] | undefined
}

export interface StopRunInput {
  runId: string
}

export interface StopRunOutput {
  runId: string
  outcome: RpcStopOutcome
}

const RPC_AGENT_ROW_SCHEMA = {
  type: "object",
  properties: {
    index: { type: "integer", minimum: 0 },
    label: { type: "string" },
    phase: { type: "string" },
    status: { type: "string", enum: [...AGENT_STATUSES] },
    reason: { type: "string" },
    outputTokens: { type: "number", minimum: 0 },
    sessionID: { type: "string" },
  },
  required: ["index", "label", "status"],
  additionalProperties: false,
} as const

const RPC_RUN_VIEW_SCHEMA = {
  type: "object",
  properties: {
    runId: { type: "string", minLength: 1 },
    workflow: { type: "string" },
    sessionID: { type: "string" },
    status: {
      type: "string",
      enum: [...RUN_STATUSES],
    },
    phase: { type: "string" },
    agents: { type: "array", items: RPC_AGENT_ROW_SCHEMA },
    done: { type: "integer", minimum: 0 },
    failed: { type: "integer", minimum: 0 },
    total: { type: "integer", minimum: 0 },
    startedAt: { type: "number" },
  },
  required: ["runId", "workflow", "sessionID", "status", "agents", "done", "failed", "total", "startedAt"],
  additionalProperties: false,
} as const

const RPC_INTERRUPTED_HINT_SCHEMA = {
  type: "object",
  properties: {
    runId: { type: "string", minLength: 1 },
    workflow: { type: "string" },
  },
  required: ["runId", "workflow"],
  additionalProperties: false,
} as const

export const UltraopenRpc = Rpc.define({
  id: "ultraopen",
  methods: {
    listRuns: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          includeHints: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          runs: { type: "array", items: RPC_RUN_VIEW_SCHEMA },
          hints: { type: "array", items: RPC_INTERRUPTED_HINT_SCHEMA },
        },
        required: ["runs"],
        additionalProperties: false,
      },
    },
    stopRun: {
      input: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
        },
        required: ["runId"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          runId: { type: "string", minLength: 1 },
          outcome: { type: "string", enum: [...STOP_OUTCOMES] },
        },
        required: ["runId", "outcome"],
        additionalProperties: false,
      },
      errors: {
        not_found: {
          type: "object",
          properties: {
            runId: { type: "string" },
          },
          additionalProperties: false,
        },
        stop_failed: {
          type: "object",
          properties: {
            runId: { type: "string" },
            reason: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
  },
  events: {
    runUpdated: {
      schema: {
        type: "object",
        properties: {
          run: RPC_RUN_VIEW_SCHEMA,
        },
        required: ["run"],
        additionalProperties: false,
      },
    },
  },
})

/** Narrows an untrusted value to a plain record, excluding arrays and `null`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
}

const AGENT_STATUS_SET: ReadonlySet<string> = new Set(AGENT_STATUSES)

const RUN_STATUS_SET: ReadonlySet<string> = new Set(RUN_STATUSES)

const STOP_OUTCOME_SET: ReadonlySet<string> = new Set(STOP_OUTCOMES)

function isAgentStatus(value: unknown): value is RpcAgentStatus {
  return typeof value === "string" && AGENT_STATUS_SET.has(value)
}

function isRunStatus(value: unknown): value is RpcRunStatus {
  return typeof value === "string" && RUN_STATUS_SET.has(value)
}

function isStopOutcome(value: unknown): value is RpcStopOutcome {
  return typeof value === "string" && STOP_OUTCOME_SET.has(value)
}

function parseAgentRow(raw: unknown): RpcAgentRow | undefined {
  if (!isRecord(raw)) {return undefined}
  const index = raw["index"],
   label = raw["label"],
   status = raw["status"]
  if (!isNonNegativeInt(index) || typeof label !== "string" || !isAgentStatus(status)) {
    return undefined
  }
  const row: RpcAgentRow = { index, label, status }
  if (typeof raw["phase"] === "string") {row.phase = raw["phase"]}
  if (typeof raw["reason"] === "string") {row.reason = raw["reason"]}
  const tokens = raw["outputTokens"]
  if (typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) {
    row.outputTokens = tokens
  }
  if (typeof raw["sessionID"] === "string") {row.sessionID = raw["sessionID"]}
  return row
}

function parseRunView(raw: unknown): RpcRunView | undefined {
  if (!isRecord(raw)) {return undefined}
  const runId = raw["runId"],
   workflow = raw["workflow"],
   sessionID = raw["sessionID"],
   status = raw["status"],
   rawAgents = raw["agents"],
   done = raw["done"],
   failed = raw["failed"],
   total = raw["total"],
   startedAt = raw["startedAt"]
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    typeof workflow !== "string" ||
    typeof sessionID !== "string" ||
    !isRunStatus(status) ||
    !Array.isArray(rawAgents) ||
    !isNonNegativeInt(done) ||
    !isNonNegativeInt(failed) ||
    !isNonNegativeInt(total) ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt)
  ) {
    return undefined
  }
  const agents: RpcAgentRow[] = []
  for (const item of rawAgents) {
    const row = parseAgentRow(item)
    if (row !== undefined) {agents.push(row)}
  }
  const view: RpcRunView = {
    runId,
    workflow,
    sessionID,
    status,
    agents,
    done,
    failed,
    total,
    startedAt,
  }
  if (typeof raw["phase"] === "string") {view.phase = raw["phase"]}
  return view
}

function parseInterruptedHint(raw: unknown): RpcInterruptedHint | undefined {
  if (!isRecord(raw)) {return undefined}
  const runId = raw["runId"],
   workflow = raw["workflow"]
  if (typeof runId !== "string" || runId.length === 0 || typeof workflow !== "string") {
    return undefined
  }
  return { runId, workflow }
}

/** Narrows an untrusted `listRuns` RPC input payload, ignoring malformed fields. */
export function parseListRunsInput(raw: unknown): ListRunsInput {
  if (!isRecord(raw)) {return {}}
  const input: ListRunsInput = {}
  if (typeof raw["sessionID"] === "string") {input.sessionID = raw["sessionID"]}
  if (typeof raw["includeHints"] === "boolean") {input.includeHints = raw["includeHints"]}
  return input
}

/** Narrows an untrusted `listRuns` RPC response payload, skipping malformed entries. */
export function parseListRunsOutput(raw: unknown): ListRunsOutput {
  if (!isRecord(raw)) {return { runs: [] }}
  const runs: RpcRunView[] = []
  if (Array.isArray(raw["runs"])) {
    for (const item of raw["runs"]) {
      const view = parseRunView(item)
      if (view !== undefined) {runs.push(view)}
    }
  }
  const output: ListRunsOutput = { runs }
  if (Array.isArray(raw["hints"])) {
    const hints: RpcInterruptedHint[] = []
    for (const item of raw["hints"]) {
      const hint = parseInterruptedHint(item)
      if (hint !== undefined) {hints.push(hint)}
    }
    output.hints = hints
  }
  return output
}

/** Validates an untrusted `stopRun` RPC input payload, throwing if `runId` is missing or invalid. */
export function parseStopRunInput(raw: unknown): StopRunInput {
  if (!isRecord(raw)) {
    throw new Error("Invalid stopRun input: expected an object")
  }
  const runId = raw["runId"]
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Invalid stopRun input: runId must be a non-empty string")
  }
  return { runId }
}

/** Validates an untrusted `stopRun` RPC response payload, throwing on malformed shapes. */
export function parseStopRunOutput(raw: unknown): StopRunOutput {
  if (!isRecord(raw)) {
    throw new Error("Invalid stopRun output: expected an object")
  }
  const runId = raw["runId"],
   outcome = raw["outcome"]
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("Invalid stopRun output: runId must be a non-empty string")
  }
  if (!isStopOutcome(outcome)) {
    throw new Error("Invalid stopRun output: unexpected outcome")
  }
  return { runId, outcome }
}

/** Narrows an untrusted `runUpdated` RPC event payload, returning `undefined` when malformed. */
export function parseRunUpdatedData(raw: unknown): { run: RpcRunView } | undefined {
  if (!isRecord(raw)) {return undefined}
  const run = parseRunView(raw["run"])
  if (run === undefined) {return undefined}
  return { run }
}
