import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createV2HostPort, ensureMessageId } from "../src/server/host/v2-adapter.js"
import type {
  V2AgentInfo,
  V2CreateSessionInput,
  V2ModelInfo,
  V2PermissionRequest,
  V2PluginContextLike,
  V2PromptInput,
  V2SessionInfo,
  V2SessionMessage,
  V2SyntheticInput,
} from "../src/server/host/v2-adapter.js"
import type { HostPort } from "../src/server/host/port.js"

/**
 * Compile-time drift guard from the consumer side: a real `@opencode/plugin@2.3.2` `Context` must be
 * accepted by `createV2HostPort`. If the installed plugin surface moves, `tsc` fails here too.
 */
const acceptsV2Context = (ctx: Plugin.Context): HostPort => createV2HostPort(ctx)
void acceptsV2Context

interface FakeCalls {
  readonly create: V2CreateSessionInput[]
  readonly get: { readonly sessionID: string }[]
  readonly move: { readonly sessionID: string; readonly directory: string; readonly delivery?: string | undefined }[]
  readonly wait: { readonly sessionID: string }[]
  readonly prompt: V2PromptInput[]
  readonly context: { readonly sessionID: string }[]
  readonly synthetic: V2SyntheticInput[]
  readonly interrupt: { readonly sessionID: string; readonly resume?: boolean | undefined }[]
  readonly modelList: unknown[]
  readonly modelDefault: unknown[]
  readonly agentGet: { readonly agentID: string; readonly location?: { readonly directory?: string | undefined } | undefined }[]
  readonly agentList: unknown[]
  readonly permissionList: { readonly sessionID: string }[]
  readonly permissionReply: {
    readonly sessionID: string
    readonly requestID: string
    readonly decision: string
    readonly message?: string | undefined
  }[]
}

interface FakeState {
  created: V2SessionInfo
  createError: unknown
  before: V2SessionInfo
  after: V2SessionInfo
  getError: unknown
  moveError: unknown
  waitError: unknown
  promptError: unknown
  contextError: unknown
  contextMessages: V2SessionMessage[]
  syntheticError: unknown
  interruptThrows: boolean
  models: V2ModelInfo[]
  defaultModel: V2ModelInfo | null
  agent: V2AgentInfo
  agentError: unknown
  agents: V2AgentInfo[]
  permissions: V2PermissionRequest[]
  permissionListError: unknown
  replyError: unknown
  sequence: string[]
}

function sessionInfo(overrides: Partial<V2SessionInfo> = {}): V2SessionInfo {
  return {
    id: "ses_child",
    projectID: "prj_1",
    tokens: { output: 0 },
    location: { directory: "/tmp/project" },
    ...overrides,
  }
}

const MODEL: V2ModelInfo = {
  id: "claude-sonnet-4-5",
  providerID: "anthropic",
  variants: [{ id: "high" }, { id: "max" }],
}

const AGENT: V2AgentInfo = {
  id: "build",
  mode: "primary",
  hidden: false,
  permissions: [{ action: "workflow", resource: "ask", effect: "allow" }],
}

function makeFake(): { ctx: V2PluginContextLike; calls: FakeCalls; state: FakeState } {
  const calls: FakeCalls = {
    create: [],
    get: [],
    move: [],
    wait: [],
    prompt: [],
    context: [],
    synthetic: [],
    interrupt: [],
    modelList: [],
    modelDefault: [],
    agentGet: [],
    agentList: [],
    permissionList: [],
    permissionReply: [],
  }
  const state: FakeState = {
    created: sessionInfo({ id: "ses_created" }),
    createError: undefined,
    before: sessionInfo(),
    after: sessionInfo(),
    getError: undefined,
    moveError: undefined,
    waitError: undefined,
    promptError: undefined,
    contextError: undefined,
    contextMessages: [],
    syntheticError: undefined,
    interruptThrows: false,
    models: [MODEL],
    defaultModel: MODEL,
    agent: AGENT,
    agentError: undefined,
    agents: [AGENT],
    permissions: [],
    permissionListError: undefined,
    replyError: undefined,
    sequence: [],
  }

  const ctx: V2PluginContextLike = {
    location: {
      directory: "/tmp/project",
      project: { id: "prj_1", canonical: "/tmp/project" },
    },
    model: {
      list(input) {
        calls.modelList.push(input)
        return Promise.resolve({ data: state.models })
      },
      default(input) {
        calls.modelDefault.push(input)
        return Promise.resolve({ data: state.defaultModel })
      },
    },
    agent: {
      get(input) {
        calls.agentGet.push(input)
        if (state.agentError !== undefined) {return Promise.reject(state.agentError)}
        return Promise.resolve({ data: state.agent })
      },
      list(input) {
        calls.agentList.push(input)
        if (state.agentError !== undefined) {return Promise.reject(state.agentError)}
        return Promise.resolve({ data: state.agents })
      },
    },
    permission: {
      list(input) {
        calls.permissionList.push(input)
        if (state.permissionListError !== undefined) {return Promise.reject(state.permissionListError)}
        return Promise.resolve(state.permissions)
      },
      reply(input) {
        calls.permissionReply.push(input)
        if (state.replyError !== undefined) {return Promise.reject(state.replyError)}
        return Promise.resolve()
      },
    },
    session: {
      create(input) {
        state.sequence.push("create")
        calls.create.push(input)
        if (state.createError !== undefined) {return Promise.reject(state.createError)}
        return Promise.resolve(state.created)
      },
      get(input) {
        calls.get.push(input)
        if (state.getError !== undefined) {return Promise.reject(state.getError)}
        return Promise.resolve(calls.get.length === 1 ? state.before : state.after)
      },
      move(input) {
        state.sequence.push("move")
        calls.move.push(input)
        if (state.moveError !== undefined) {return Promise.reject(state.moveError)}
        return Promise.resolve()
      },
      wait(input) {
        state.sequence.push("wait")
        calls.wait.push(input)
        if (state.waitError !== undefined) {return Promise.reject(state.waitError)}
        return Promise.resolve()
      },
      prompt(input) {
        state.sequence.push("prompt")
        calls.prompt.push(input)
        if (state.promptError !== undefined) {return Promise.reject(state.promptError)}
        return Promise.resolve({ id: input.id })
      },
      context(input) {
        state.sequence.push("context")
        calls.context.push(input)
        if (state.contextError !== undefined) {return Promise.reject(state.contextError)}
        return Promise.resolve(state.contextMessages)
      },
      synthetic(input) {
        state.sequence.push("synthetic")
        calls.synthetic.push(input)
        if (state.syntheticError !== undefined) {return Promise.reject(state.syntheticError)}
        return Promise.resolve({ id: input.id })
      },
      interrupt(input) {
        state.sequence.push("interrupt")
        calls.interrupt.push(input)
        if (state.interruptThrows) {return Promise.reject(new Error("interrupt failed"))}
        return Promise.resolve({ interrupted: true })
      },
    },
  }
  return { ctx, calls, state }
}

describe("ensureMessageId", () => {
  test("returns valid msg_-prefixed IDs unchanged", () => {
    expect(ensureMessageId("msg_ultraopen_outcome_run1")).toBe("msg_ultraopen_outcome_run1")
    expect(ensureMessageId("msg_")).toBe("msg_")
  })

  test("throws for blank IDs and IDs without the msg_ prefix", () => {
    expect(() => ensureMessageId("")).toThrow(/msg_/u)
    expect(() => ensureMessageId("   ")).toThrow(/msg_/u)
    expect(() => ensureMessageId("ses_abc")).toThrow(/msg_/u)
    expect(() => ensureMessageId("ultraopen_outcome_run1")).toThrow(/msg_/u)
  })
})

describe("HostPort location surface", () => {
  test("projects directory, canonical project directory, and project ID", () => {
    const { ctx } = makeFake()
    const port = createV2HostPort(ctx)
    expect(port.location).toEqual({
      directory: "/tmp/project",
      canonical: "/tmp/project",
      projectID: "prj_1",
    })
  })
})

describe("models and agents", () => {
  test("listModels maps the V2 variants array of objects to string IDs", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.listModels()).toEqual([
      { providerID: "anthropic", modelID: "claude-sonnet-4-5", variants: ["high", "max"] },
    ])
    expect(calls.modelList).toEqual([undefined])
  })

  test("defaultModel maps ModelInfo.id to HostModelRef.modelID and handles no default", async () => {
    const { ctx, state } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.defaultModel()).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
    state.defaultModel = null
    expect(await port.defaultModel()).toBeUndefined()
  })

  test("defaultModel maps the catalog row's id even when variants are listed", async () => {
    const { ctx, state } = makeFake()
    state.defaultModel = { ...MODEL, variants: [{ id: "high" }] }
    const port = createV2HostPort(ctx)
    expect(await port.defaultModel()).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4-5",
    })
  })

  test("getAgent passes the location only when a directory is supplied", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.getAgent("build")).toEqual({
      id: "build",
      mode: "primary",
      hidden: false,
      permissions: [{ action: "workflow", resource: "ask", effect: "allow" }],
    })
    expect(await port.getAgent("build", "/tmp/wt")).toEqual({
      id: "build",
      mode: "primary",
      hidden: false,
      permissions: [{ action: "workflow", resource: "ask", effect: "allow" }],
    })
    expect(calls.agentGet).toEqual([
      { agentID: "build" },
      { agentID: "build", location: { directory: "/tmp/wt" } },
    ])
  })

  test("getAgent returns undefined when the host rejects the lookup", async () => {
    const { ctx, state } = makeFake()
    state.agentError = new Error("no such agent")
    const port = createV2HostPort(ctx)
    expect(await port.getAgent("missing")).toBeUndefined()
  })

  test("listAgents maps rows and passes the location only when supplied", async () => {
    const { ctx, calls, state } = makeFake()
    state.agents = [AGENT, { ...AGENT, id: "plan", mode: "subagent", hidden: true }]
    const port = createV2HostPort(ctx)
    expect(await port.listAgents()).toHaveLength(2)
    expect(await port.listAgents("/tmp/wt")).toHaveLength(2)
    expect(calls.agentList).toEqual([undefined, { location: { directory: "/tmp/wt" } }])
  })

  test("listAgents fails safe with an empty list when the host rejects", async () => {
    const { ctx, state } = makeFake()
    state.agentError = new Error("host offline")
    const port = createV2HostPort(ctx)
    expect(await port.listAgents()).toEqual([])
  })
})

describe("permissions", () => {
  test("listPendingPermissions projects request rows", async () => {
    const { ctx, calls, state } = makeFake()
    state.permissions = [
      { id: "per_1", action: "bash", resources: ["rm -rf /"] },
      { id: "per_2", action: "edit", resources: ["a.ts", "b.ts"] },
    ]
    const port = createV2HostPort(ctx)
    expect(await port.listPendingPermissions("ses_1")).toEqual([
      { id: "per_1", action: "bash", resources: ["rm -rf /"] },
      { id: "per_2", action: "edit", resources: ["a.ts", "b.ts"] },
    ])
    expect(calls.permissionList).toEqual([{ sessionID: "ses_1" }])
  })

  test("listPendingPermissions fails safe with an empty list when the host rejects", async () => {
    const { ctx, state } = makeFake()
    state.permissionListError = new Error("session gone")
    const port = createV2HostPort(ctx)
    expect(await port.listPendingPermissions("ses_gone")).toEqual([])
  })

  test("rejectPermission replies with decision reject and the supplied message", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    await port.rejectPermission("ses_1", "per_1", "ultraopen: denied")
    expect(calls.permissionReply).toEqual([
      { sessionID: "ses_1", requestID: "per_1", decision: "reject", message: "ultraopen: denied" },
    ])
  })
})

describe("sessions", () => {
  test("getSession maps output tokens, model, permissions, metadata, and parentID", async () => {
    const { ctx, calls, state } = makeFake()
    state.before = sessionInfo({
      parentID: "ses_parent",
      agent: "build",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "high" },
      permissions: [{ action: "workflow", resource: "ask", effect: "allow" }],
      metadata: { ultraopen: { runId: "wf_1", index: 0 } },
      tokens: { output: 42 },
    })
    const port = createV2HostPort(ctx)
    expect(await port.getSession("ses_child")).toEqual({
      id: "ses_child",
      parentID: "ses_parent",
      projectID: "prj_1",
      directory: "/tmp/project",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" },
      permissions: [{ action: "workflow", resource: "ask", effect: "allow" }],
      metadata: { ultraopen: { runId: "wf_1", index: 0 } },
      outputTokens: 42,
    })
    expect(calls.get).toEqual([{ sessionID: "ses_child" }])
  })

  test("getSession omits absent optional fields and returns undefined on a missing session", async () => {
    const { ctx, state } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.getSession("ses_child")).toEqual({
      id: "ses_child",
      projectID: "prj_1",
      directory: "/tmp/project",
      outputTokens: 0,
    })
    state.getError = Object.assign(new Error("not found"), { _tag: "NotFound" })
    expect(await port.getSession("ses_gone")).toBeUndefined()
  })
})

describe("createChildSession", () => {
  test("never forwards parentID, maps modelID to id, and passes lineage metadata", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    const permissions = [{ action: "workflow", resource: "status", effect: "allow" as const }]
    const result = await port.createChildSession({
      title: "audit agent 1",
      agent: "build",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", variant: "high" },
      location: "/tmp/worktree",
      metadata: { ultraopen: { runId: "wf_1", parentSessionID: "ses_parent", index: 0 } },
      permissions,
    })
    expect(result).toEqual({ ok: true, sessionID: "ses_created" })
    const call = calls.create[0]
    expect(call).toBeDefined()
    expect("parentID" in (call ?? {})).toBe(false)
    expect(call).toEqual({
      title: "audit agent 1",
      agent: "build",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic", variant: "high" },
      location: { directory: "/tmp/worktree" },
      metadata: { ultraopen: { runId: "wf_1", parentSessionID: "ses_parent", index: 0 } },
      permissions,
    })
  })

  test("omits optional keys rather than sending undefined values", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    await port.createChildSession({ title: "plain", metadata: { ultraopen: {} } })
    const call = calls.create[0] ?? {}
    expect("parentID" in call).toBe(false)
    expect("agent" in call).toBe(false)
    expect("model" in call).toBe(false)
    expect("location" in call).toBe(false)
    expect("permissions" in call).toBe(false)
    expect(call).toEqual({ title: "plain", metadata: { ultraopen: {} } })
  })

  test("returns a failure detail when create throws or yields no session ID", async () => {
    const { ctx, state } = makeFake()
    const port = createV2HostPort(ctx)
    state.createError = new Error("create rejected")
    expect(await port.createChildSession({ title: "a", metadata: {} })).toEqual({
      ok: false,
      detail: "create rejected",
    })
    state.createError = undefined
    state.created = sessionInfo({ id: "" })
    expect(await port.createChildSession({ title: "b", metadata: {} })).toEqual({
      ok: false,
      detail: expect.stringContaining("session ID"),
    })
  })

  test("normalizes non-Error host failures into a detail string", async () => {
    const { ctx, state } = makeFake()
    const port = createV2HostPort(ctx)
    state.createError = "plain failure"
    expect(await port.createChildSession({ title: "a", metadata: {} })).toEqual({
      ok: false,
      detail: "plain failure",
    })
    state.createError = { message: "structured failure" }
    expect(await port.createChildSession({ title: "b", metadata: {} })).toEqual({
      ok: false,
      detail: "structured failure",
    })
    state.createError = { code: 500 }
    expect(await port.createChildSession({ title: "c", metadata: {} })).toEqual({
      ok: false,
      detail: "[object Object]",
    })
  })
})

describe("moveSession", () => {
  test("steers, waits, and verifies the resolved directory", async () => {
    const { ctx, calls, state } = makeFake()
    state.before = sessionInfo({ location: { directory: resolve("relative/worktree") } })
    const port = createV2HostPort(ctx)
    expect(await port.moveSession("ses_1", "relative/worktree")).toEqual({ ok: true })
    expect(calls.move).toEqual([{ sessionID: "ses_1", directory: "relative/worktree", delivery: "steer" }])
    expect(calls.wait).toEqual([{ sessionID: "ses_1" }])
    expect(calls.get).toEqual([{ sessionID: "ses_1" }])
    expect(state.sequence).toEqual(["move", "wait"])
  })

  test("fails closed when the session lands in a different directory", async () => {
    const { ctx, state } = makeFake()
    state.before = sessionInfo({ location: { directory: "/somewhere/else" } })
    const port = createV2HostPort(ctx)
    const result = await port.moveSession("ses_1", "/tmp/worktree")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toContain("/somewhere/else")
      expect(result.detail).toContain(resolve("/tmp/worktree"))
    }
  })

  test("accepts a physical-path alias (symlink -> realpath) as matching directory", async () => {
    const base = await mkdtemp(join(tmpdir(), "ultraopen-alias-")),
     real = join(base, "real"),
     link = join(base, "link")
    await mkdir(real, { recursive: true })
    await symlink(real, link)
    try {
      const { ctx, state } = makeFake()
      // The host reports the realpath, while the caller named the symlink: same physical dir.
      state.before = sessionInfo({ location: { directory: real } })
      const port = createV2HostPort(ctx)
      expect(await port.moveSession("ses_1", link)).toEqual({ ok: true })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })

  test("fails closed when move or wait rejects", async () => {
    const { ctx, state } = makeFake()
    const port = createV2HostPort(ctx)
    state.moveError = new Error("move failed")
    expect(await port.moveSession("ses_1", "/tmp/wt")).toEqual({ ok: false, detail: "move failed" })
    state.moveError = undefined
    state.waitError = new Error("wait failed")
    expect(await port.moveSession("ses_1", "/tmp/wt")).toEqual({ ok: false, detail: "wait failed" })
  })
})

describe("runTurn", () => {
  test("rejects a non-msg_ message ID without touching the session", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "bad-id", text: "hi" })
    expect(result.ok).toBe(false)
    if (!result.ok) {expect(result.detail).toContain("msg_")}
    expect(calls.prompt).toEqual([])
    expect(calls.get).toEqual([])
  })

  test("prompts, waits, slices strictly after messageID, sums steps, and takes the last text", async () => {
    const { ctx, calls, state } = makeFake()
    state.before = sessionInfo({ tokens: { output: 10 } })
    state.contextMessages = [
      { id: "msg_stale", type: "assistant", tokens: { output: 100 }, content: [{ type: "text", text: "stale" }] },
      { id: "msg_turn", type: "user", text: "do the thing" },
      {
        id: "msg_step_1",
        type: "assistant",
        tokens: { output: 3 },
        content: [{ type: "text", text: "first" }, { type: "tool" }],
      },
      { id: "msg_step_2", type: "assistant", tokens: { output: 4 }, content: [{ type: "text", text: "final" }] },
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
    ]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "do the thing" })
    expect(result).toEqual({
      ok: true,
      turn: { outcome: "succeeded", text: "final", outputTokens: 7 },
    })
    expect(calls.prompt).toEqual([
      { sessionID: "ses_1", id: "msg_turn", text: "do the thing", delivery: "steer" },
    ])
    expect(calls.wait).toEqual([{ sessionID: "ses_1" }])
    expect(calls.context).toEqual([{ sessionID: "ses_1" }])
    expect(state.sequence).toEqual(["prompt", "wait", "context"])
  })

  test("falls back to the cumulative token delta after a compaction hides messageID", async () => {
    const { ctx, calls, state } = makeFake()
    state.before = sessionInfo({ tokens: { output: 10 } })
    state.after = sessionInfo({ tokens: { output: 25 } })
    state.contextMessages = [
      { id: "msg_compact", type: "compaction", status: "completed" },
      {
        id: "msg_after_compact",
        type: "assistant",
        tokens: { output: 5 },
        content: [{ type: "text", text: "compacted answer" }],
      },
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
    ]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "again" })
    expect(result).toEqual({
      ok: true,
      turn: { outcome: "succeeded", text: "compacted answer", outputTokens: 15 },
    })
    expect(calls.get).toEqual([{ sessionID: "ses_1" }, { sessionID: "ses_1" }])
  })

  test("maps failed turns and their structured error", async () => {
    const { ctx, state } = makeFake()
    state.contextMessages = [
      { id: "msg_turn", type: "user", text: "go" },
      {
        id: "msg_step",
        type: "assistant",
        tokens: { output: 2 },
        content: [{ type: "reasoning", text: "thinking" }],
        error: { type: "api-error", message: "provider exploded" },
      },
      {
        id: "msg_idle",
        type: "idle",
        outcome: "failed",
        error: { type: "api-error", message: "provider exploded" },
      },
    ]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })
    expect(result).toEqual({
      ok: true,
      turn: {
        outcome: "failed",
        text: "",
        outputTokens: 2,
        error: { type: "api-error", message: "provider exploded" },
      },
    })
  })

  test("maps interrupted turns and falls back to the session outcome when no idle message lands", async () => {
    const { ctx, calls, state } = makeFake()
    state.after = sessionInfo({ outcome: "interrupted" })
    state.contextMessages = [{ id: "msg_turn", type: "user", text: "go" }]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })
    expect(result).toEqual({
      ok: true,
      turn: { outcome: "interrupted", text: "", outputTokens: 0 },
    })
    expect(calls.get).toHaveLength(2)
  })

  test("defaults to succeeded when neither an idle message nor a session outcome is available", async () => {
    const { ctx, state } = makeFake()
    state.contextMessages = [{ id: "msg_turn", type: "user", text: "go" }]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })
    expect(result.ok).toBe(true)
    if (result.ok) {expect(result.turn.outcome).toBe("succeeded")}
  })

  test("sums the whole visible context when messageID is absent and no compaction is recorded", async () => {
    const { ctx, state } = makeFake()
    state.contextMessages = [
      { id: "msg_step", type: "assistant", tokens: { output: 9 }, content: [{ type: "text", text: "partial" }] },
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
    ]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })
    expect(result).toEqual({ ok: true, turn: { outcome: "succeeded", text: "partial", outputTokens: 9 } })
  })

  test("ignores a stale error recorded before this turn's messageID", async () => {
    const { ctx, state } = makeFake()
    state.contextMessages = [
      {
        id: "msg_old_step",
        type: "assistant",
        tokens: { output: 40 },
        content: [{ type: "text", text: "old answer" }],
        error: { type: "api-error", message: "old failure" },
      },
      { id: "msg_old_idle", type: "idle", outcome: "failed", error: { type: "api-error", message: "old failure" } },
      { id: "msg_turn", type: "user", text: "go" },
      { id: "msg_step", type: "assistant", tokens: { output: 2 }, content: [{ type: "text", text: "fresh" }] },
      { id: "msg_idle", type: "idle", outcome: "succeeded" },
    ]
    const port = createV2HostPort(ctx)
    const result = await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })
    expect(result).toEqual({ ok: true, turn: { outcome: "succeeded", text: "fresh", outputTokens: 2 } })
  })

  test("fails closed when prompt, wait, context, or the baseline lookup rejects", async () => {
    const { ctx, state } = makeFake()
    const port = createV2HostPort(ctx)
    state.promptError = new Error("prompt rejected")
    expect(await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })).toEqual({
      ok: false,
      detail: "prompt rejected",
    })
    state.promptError = undefined
    state.waitError = new Error("wait rejected")
    expect(await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })).toEqual({
      ok: false,
      detail: "wait rejected",
    })
    state.waitError = undefined
    state.contextError = new Error("context rejected")
    expect(await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })).toEqual({
      ok: false,
      detail: "context rejected",
    })
    state.contextError = undefined
    state.getError = new Error("get rejected")
    expect(await port.runTurn({ sessionID: "ses_1", messageID: "msg_turn", text: "go" })).toEqual({
      ok: false,
      detail: "get rejected",
    })
  })
})

describe("interruptSession", () => {
  test("interrupts without resuming", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.interruptSession("ses_1")).toBe(true)
    expect(calls.interrupt).toEqual([{ sessionID: "ses_1", resume: false }])
  })

  test("returns false instead of throwing when the interrupt rejects", async () => {
    const { ctx, state } = makeFake()
    state.interruptThrows = true
    const port = createV2HostPort(ctx)
    expect(await port.interruptSession("ses_1")).toBe(false)
  })
})

describe("admitSynthetic", () => {
  test("passes every delivery field through for a valid msg_ ID", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    const outcome = await port.admitSynthetic({
      sessionID: "ses_1",
      id: "msg_ultraopen_outcome_wf_1",
      text: "Workflow audit succeeded",
      description: "Workflow audit succeeded",
      metadata: { ultraopen: { kind: "outcome", runId: "wf_1" } },
      delivery: "steer",
      resume: true,
    })
    expect(outcome).toBe("admitted")
    expect(calls.synthetic).toEqual([
      {
        sessionID: "ses_1",
        id: "msg_ultraopen_outcome_wf_1",
        text: "Workflow audit succeeded",
        description: "Workflow audit succeeded",
        metadata: { ultraopen: { kind: "outcome", runId: "wf_1" } },
        delivery: "steer",
        resume: true,
      },
    ])
  })

  test("omits optional fields when absent", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.admitSynthetic({ sessionID: "ses_1", id: "msg_stop", text: "stop" })).toBe("admitted")
    expect(calls.synthetic).toEqual([{ sessionID: "ses_1", id: "msg_stop", text: "stop" }])
  })

  test("rejects a non-msg_ ID as an error without calling the host", async () => {
    const { ctx, calls } = makeFake()
    const port = createV2HostPort(ctx)
    expect(await port.admitSynthetic({ sessionID: "ses_1", id: "stop", text: "stop" })).toBe("error")
    expect(calls.synthetic).toEqual([])
  })

  test("maps NotFound to session-missing", async () => {
    const { ctx, state } = makeFake()
    state.syntheticError = Object.assign(new Error("session not found"), { _tag: "NotFound" })
    const port = createV2HostPort(ctx)
    expect(await port.admitSynthetic({ sessionID: "ses_gone", id: "msg_stop", text: "stop" })).toBe(
      "session-missing",
    )
  })

  test("maps a 404 status to session-missing", async () => {
    const { ctx, state } = makeFake()
    state.syntheticError = Object.assign(new Error("gone"), { status: 404 })
    const port = createV2HostPort(ctx)
    expect(await port.admitSynthetic({ sessionID: "ses_gone", id: "msg_stop", text: "stop" })).toBe(
      "session-missing",
    )
  })

  test("maps conflict errors to conflict", async () => {
    const { ctx, state } = makeFake()
    state.syntheticError = Object.assign(new Error("already admitted"), { name: "ConflictError" })
    const port = createV2HostPort(ctx)
    expect(await port.admitSynthetic({ sessionID: "ses_1", id: "msg_stop", text: "stop" })).toBe("conflict")
    state.syntheticError = Object.assign(new Error("duplicate"), { statusCode: 409 })
    expect(await port.admitSynthetic({ sessionID: "ses_1", id: "msg_stop", text: "stop" })).toBe("conflict")
  })

  test("maps every other failure to error", async () => {
    const { ctx, state } = makeFake()
    state.syntheticError = new Error("transport lost")
    const port = createV2HostPort(ctx)
    expect(await port.admitSynthetic({ sessionID: "ses_1", id: "msg_stop", text: "stop" })).toBe("error")
    state.syntheticError = "plain string failure"
    expect(await port.admitSynthetic({ sessionID: "ses_1", id: "msg_stop", text: "stop" })).toBe("error")
  })
})
