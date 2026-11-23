import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import plugin, { createUltraopenServer } from "../src/server/index.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { STATUS_TOOL, STRUCTURED_OUTPUT_TOOL, WORKFLOW_TOOL } from "../src/server/bridge/permission.js"
import {
  dropSettled,
  registerPending,
  settlePromiseOf,
} from "../src/server/tool/background.js"
import {
  artifactPaths,
  dataRoot,
  ensureRunDir,
  readManifest,
  writeManifest,
  writeScript,
} from "../src/server/resume/store.js"
import { argsHash } from "../src/server/resume/key.js"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeFakePlugin, rpcContext } from "./v2-fixtures.js"
import type { FakePlugin, FakeRpcCall } from "./v2-fixtures.js"

/**
 * The V2 composition root, driven through a structural fake of `Plugin.Context`.
 *
 * These tests pin the cutover contracts that a live host cannot make cheaply: the plugin's id and
 * cleanup, transform/hook/RPC wiring, the no-`output` tool result rule, permission rethrow with
 * cleanup, StructuredOutput capture, the zero-token orphan interceptor, shell recursion
 * containment, stale approval revocation, and the reload/disable scope.
 */

let dataHome: string,
 savedDataHome: string | undefined

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "ultraopen-v2-"))
  savedDataHome = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
})

afterAll(async () => {
  if (savedDataHome === undefined) {delete process.env["XDG_DATA_HOME"]}
  else {process.env["XDG_DATA_HOME"] = savedDataHome}
  await rm(dataHome, { recursive: true, force: true })
})

const META = "export const meta = { name: 'demo', description: 'a demo workflow' }\n"
const runIdOf = (output: string): string => output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
const listRoot = async (): Promise<string[]> => await readdir(dataRoot(undefined)).catch(() => [])

const waitFor = async (until: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let waited = 0; waited < 600; waited++) {
    if (await until()) {return}
    await new Promise((resolve) => {setTimeout(resolve, 10)})
  }
  throw new Error(`timed out waiting for ${what}`)
}

interface Started {
  fake: FakePlugin
  coordinator: RuntimeCoordinator
  cleanup: () => Promise<void>
}

/** Starts the real plugin against a fresh fake context. */
async function start(
  options: Parameters<typeof makeFakePlugin>[0] = {},
  pluginOptions: Record<string, unknown> = {},
): Promise<Started> {
  const fake = makeFakePlugin(options)
  ;(fake.ctx as unknown as { options: Record<string, unknown> }).options = pluginOptions
  const cleanup = await plugin.setup(fake.ctx)
  if (cleanup === undefined) {throw new Error("setup returned no cleanup")}
  fake.cleanup = cleanup
  return {
    fake,
    coordinator: getCoordinator(),
    cleanup: async (): Promise<void> => {
      await cleanup()
      // Let the subscription loop observe the abort and exit.
      await new Promise((resolve) => {setTimeout(resolve, 10)})
    },
  }
}

/** A child-session record the tool/hook tests can drive directly. */
function ownChild(
  coordinator: RuntimeCoordinator,
  sessionID: string,
  overrides: Partial<Parameters<RuntimeCoordinator["registerChild"]>[1]> = {},
): void {
  coordinator.registerChild(sessionID, {
    runId: "run-1",
    projectKey: "project-1",
    parentSessionID: "parent",
    ancestorSessionIDs: ["parent"],
    index: 0,
    label: "worker",
    lastActivityAt: Date.now(),
    currentAttempt: 1,
    ...overrides,
  })
}

/** Writes one running manifest (and script) into the temp data root. */
async function writeRunningRun(runId: string, sessionID: string, bootId = getCoordinator().processBootId): Promise<void> {
  await ensureRunDir(runId)
  await writeManifest(runId, {
    runId,
    bootId,
    pid: process.pid,
    sessionID,
    sourceHash: "s",
    argsHash: argsHash(undefined),
    status: "running",
    childSessionIDs: [],
    startedAt: Date.now(),
  })
  await writeScript(runId, `${META}return 1\n`)
}

beforeEach(() => {
  resetCoordinatorForTests()
})

afterEach(() => {
  delete process.env["ULTRAOPEN_ACTIVE"]
})

describe("plugin definition and setup", () => {
  test("the default export is a V2 Plugin.define with id ultraopen", () => {
    expect(plugin.id).toBe("ultraopen")
    expect(typeof plugin.setup).toBe("function")
    expect(createUltraopenServer().id).toBe("ultraopen")
  })

  test("setup registers transforms, hooks, RPC and returns an async cleanup", async () => {
    const started = await start()
    try {
      expect(started.fake.tools.get(WORKFLOW_TOOL)).toBeDefined()
      expect(started.fake.tools.get(STATUS_TOOL)).toBeDefined()
      expect(started.fake.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeDefined()
      expect(started.fake.agents.some((agent) => agent.id === "ultracode")).toBe(true)
      expect(started.fake.commands.has("ultracode")).toBe(true)
      expect(started.fake.skills.has("workflow-authoring")).toBe(true)
      expect(started.fake.sessionHooks.has("prompt")).toBe(true)
      expect(started.fake.sessionHooks.has("context")).toBe(true)
      expect(started.fake.permissionHooks.has("evaluate")).toBe(true)
      expect(started.fake.toolHooks.has("execute.before")).toBe(true)
      expect(started.fake.shellHooks.has("create.before")).toBe(true)
      expect(started.fake.rpcCalls[0]?.definition.id).toBe("ultraopen")
      expect(typeof started.fake.cleanup).toBe("function")
    } finally {
      await started.cleanup()
    }
  })

  test("the tool transforms use complete JSON schemas and codemode off", async () => {
    const started = await start()
    try {
      const workflow = started.fake.tools.get(WORKFLOW_TOOL)
      expect(workflow?.input["type"]).toBe("object")
      expect(workflow?.input["additionalProperties"]).toBe(false)
      expect(workflow?.options?.codemode).toBe(false)
      expect(started.fake.tools.get(STATUS_TOOL)?.input["required"]).toEqual(["runId"])
    } finally {
      await started.cleanup()
    }
  })
})

describe("tool results", () => {
  test("a successful dry run returns content and NEVER an output key", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}return { ok: 1 }\n`,
        dryRun: true,
      })
      expect("output" in result).toBe(false)
      expect(String(result.content)).toContain(`<result workflow="demo"`)
    } finally {
      await started.cleanup()
    }
  })

  test("the blocking contract returns the result as content, no output key", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}await agent('a')\nreturn 'blocking-value'\n`,
        background: false,
      })
      expect("output" in result).toBe(false)
      expect(String(result.content)).toContain("blocking-value")
    } finally {
      await started.cleanup()
    }
  })

  test("the status tool reads disk and returns content, no output key", async () => {
    const started = await start()
    try {
      const launched = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}await agent('a')\nreturn 'status-value'\n`,
        background: true,
      })
      const runId = runIdOf(String(launched.content))
      await settlePromiseOf(started.coordinator, runId)
      const status = await started.fake.runTool(STATUS_TOOL, { runId, wait: 5 })
      expect("output" in status).toBe(false)
      expect(String(status.content)).toContain('status="completed"')
      expect(String(status.content)).toContain("status-value")
    } finally {
      await started.cleanup()
    }
  })

  test("an unknown status run id is a clear error, never a crash", async () => {
    const started = await start()
    try {
      const status = await started.fake.runTool(STATUS_TOOL, { runId: "wf_missing000" })
      expect(String(status.content)).toContain("No run found")
    } finally {
      await started.cleanup()
    }
  })
})

describe("permission.rethrow", () => {
  test("a Tool.Error rejection cleans up the pending run dir and RETHROWS", async () => {
    const started = await start({ assertPermission: () => Promise.reject(new ToolError({ message: "denied by user" })) })
    try {
      const before = new Set(await listRoot())
      await expect(started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n` })).rejects.toThrow("denied by user")
      expect(started.coordinator.runs.size).toBe(0)
      const after = await listRoot()
      expect(after.filter((name) => !before.has(name))).toEqual([])
    } finally {
      await started.cleanup()
    }
  })

  test("a plain rejection (no feedback) also rethrows instead of becoming tool text", async () => {
    const started = await start({ assertPermission: () => Promise.reject(new Error("step aborted")) })
    try {
      const result = started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n` })
      await expect(result).rejects.toThrow("step aborted")
    } finally {
      await started.cleanup()
    }
  })
})

describe("StructuredOutput capture", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  }

  test("a valid payload is captured as a structuredClone for the CURRENT attempt", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child", { schema, currentAttempt: 2 })
      const payload = { answer: "yes" }
      const result = await started.fake.runTool(STRUCTURED_OUTPUT_TOOL, payload, { sessionID: "child" })
      expect("output" in result).toBe(false)
      expect(result.metadata?.["structured"]).toEqual(payload)
      const captured = started.coordinator.childOf("child")?.captured
      expect(captured?.attempt).toBe(2)
      expect(captured?.value).toEqual(payload)
      // A clone, not the caller's object.
      expect(captured?.value).not.toBe(payload)
    } finally {
      await started.cleanup()
    }
  })

  test("an invalid payload throws Tool.Error for in-loop repair and records the errors", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child", { schema })
      await expect(
        started.fake.runTool(STRUCTURED_OUTPUT_TOOL, { wrong: true }, { sessionID: "child" }),
      ).rejects.toThrow(/did not match the required schema/u)
      expect(started.coordinator.childOf("child")?.lastValidationErrors?.length).toBeGreaterThan(0)
      expect(started.coordinator.childOf("child")?.captured).toBeUndefined()
    } finally {
      await started.cleanup()
    }
  })

  test("a non-object root schema is wrapped in a { value } envelope", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child", { schema: { type: "number" }, wrapped: true })
      const result = await started.fake.runTool(STRUCTURED_OUTPUT_TOOL, { value: 42 }, { sessionID: "child" })
      expect(result.metadata?.["structured"]).toEqual({ value: 42 })
      expect(started.coordinator.childOf("child")?.captured?.value).toEqual({ value: 42 })
    } finally {
      await started.cleanup()
    }
  })

  test("outside an owned child the tool refuses", async () => {
    const started = await start()
    try {
      await expect(
        started.fake.runTool(STRUCTURED_OUTPUT_TOOL, { answer: "x" }, { sessionID: "parent" }),
      ).rejects.toThrow(/only available inside/u)
    } finally {
      await started.cleanup()
    }
  })

  test("a child without a requested schema refuses StructuredOutput", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      await expect(
        started.fake.runTool(STRUCTURED_OUTPUT_TOOL, { answer: "x" }, { sessionID: "child" }),
      ).rejects.toThrow(/no requested structured schema/u)
    } finally {
      await started.cleanup()
    }
  })
})

describe("hook(context) — child contract and tool filtering", () => {
  test("a schema child gets its contract, the normalized schema, and no recursion tools", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child", {
        contractText: "CONTRACT-TEXT",
        schema: { type: "number" },
        disallowedTools: ["edit"],
      })
      const event = {
        sessionID: "child",
        agent: "build",
        system: [] as { type: "text"; text: string }[],
        messages: [],
        tools: {
          [WORKFLOW_TOOL]: { description: "", input: {} },
          [STATUS_TOOL]: { description: "", input: {} },
          subagent: { description: "", input: {} },
          todowrite: { description: "", input: {} },
          edit: { description: "", input: {} },
          [STRUCTURED_OUTPUT_TOOL]: { description: "", input: {} },
        },
      }
      await started.fake.hook("session", "context", event)
      expect(event.system.some((part) => part.text === "CONTRACT-TEXT")).toBe(true)
      const tools = event.tools as Record<string, { description: string; input: Record<string, unknown> }>
      expect(tools[STRUCTURED_OUTPUT_TOOL]?.input["type"]).toBe("object")
      expect(tools[STRUCTURED_OUTPUT_TOOL]?.input["properties"]).toEqual({ value: { type: "number" } })
      for (const name of [WORKFLOW_TOOL, STATUS_TOOL, "subagent", "todowrite", "edit"]) {
        expect(name in tools).toBe(false)
      }
    } finally {
      await started.cleanup()
    }
  })

  test("a non-schema child loses StructuredOutput", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      const event = {
        sessionID: "child",
        agent: "build",
        system: [],
        messages: [],
        tools: { [STRUCTURED_OUTPUT_TOOL]: { description: "", input: {} } },
      }
      await started.fake.hook("session", "context", event)
      expect(STRUCTURED_OUTPUT_TOOL in event.tools).toBe(false)
    } finally {
      await started.cleanup()
    }
  })

  test("a non-child session loses StructuredOutput", async () => {
    const started = await start({ sessions: { parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "build" } } })
    try {
      const event = {
        sessionID: "parent",
        agent: "build",
        system: [],
        messages: [],
        tools: { [STRUCTURED_OUTPUT_TOOL]: { description: "", input: {} } },
      }
      await started.fake.hook("session", "context", event)
      expect(STRUCTURED_OUTPUT_TOOL in event.tools).toBe(false)
    } finally {
      await started.cleanup()
    }
  })

  test("compaction and generate always delete StructuredOutput", async () => {
    const started = await start()
    try {
      for (const hookName of ["compaction", "generate"]) {
        const event = { tools: { [STRUCTURED_OUTPUT_TOOL]: { description: "", input: {} } } }
        await started.fake.hook("session", hookName, event)
        expect(STRUCTURED_OUTPUT_TOOL in event.tools).toBe(false)
      }
    } finally {
      await started.cleanup()
    }
  })

  test("an ordinary subagent session cannot see the workflow tools", async () => {
    const started = await start({
      sessions: {
        sub: { id: "sub", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "explore" },
      },
    })
    try {
      const event = {
        sessionID: "sub",
        agent: "explore",
        system: [],
        messages: [],
        tools: { [WORKFLOW_TOOL]: { description: "", input: {} }, [STATUS_TOOL]: { description: "", input: {} } },
      }
      await started.fake.hook("session", "context", event)
      expect(WORKFLOW_TOOL in event.tools).toBe(false)
      expect(STATUS_TOOL in event.tools).toBe(false)
    } finally {
      await started.cleanup()
    }
  })
})

describe("single-pass ancestor resolution", () => {
  const TEN_TOOLS = [
    "shell", "edit", "read", "write", "patch",
    "apply_patch", "list", "glob", "grep", "webfetch",
  ]

  const toolsOf = (): Record<string, { description: string; input: Record<string, unknown> }> =>
    Object.fromEntries(TEN_TOOLS.map((name) => [name, { description: "", input: {} }]))

  test("hook(context) resolves the ancestor chain ONCE across many child tools and keeps allow-overridden tools visible", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        {
          id: "gatekeeper",
          name: "gatekeeper",
          mode: "primary",
          hidden: false,
          permissions: [
            { action: "shell", resource: "*", effect: "deny" },
            { action: "shell", resource: "git status", effect: "allow" },
            { action: "edit", resource: "*", effect: "deny" },
          ],
        },
      ],
      sessions: {
        parent: {
          id: "parent",
          projectID: "project-1",
          location: { directory: "/work" },
          tokens: { output: 0 },
          agent: "gatekeeper",
        },
      },
    })
    try {
      ownChild(started.coordinator, "child")
      const raw = started.fake.ctx as unknown as {
        session: { get: (input: { sessionID: string }) => Promise<unknown> }
      }
      const originalGet = raw.session.get
      let fetched = 0
      raw.session.get = (input) => {
        fetched++
        return originalGet(input)
      }

      const event = {
        sessionID: "child",
        agent: "build",
        system: [] as { type: "text"; text: string }[],
        messages: [],
        tools: toolsOf(),
      }
      await started.fake.hook("session", "context", event)

      // ONE walk of the ancestor chain serves all ten tools.
      expect(fetched).toBe(1)
      // The narrow "git status" allow comes last for the shell action, so the tool stays VISIBLE.
      expect("shell" in event.tools).toBe(true)
      expect("edit" in event.tools).toBe(false)
      expect("read" in event.tools).toBe(true)
    } finally {
      await started.cleanup()
    }
  })

  test("an unresolvable ancestor chain fails closed, keeping only the StructuredOutput capture channel", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child", { schema: { type: "object" } })
      const event = {
        sessionID: "child",
        agent: "build",
        system: [] as { type: "text"; text: string }[],
        messages: [],
        tools: toolsOf(),
      }
      await started.fake.hook("session", "context", event)
      expect(Object.keys(event.tools)).toEqual([STRUCTURED_OUTPUT_TOOL])
    } finally {
      await started.cleanup()
    }
  })
})

/** Counts how many times one setup call disposed its RPC registration. */
function countRegistrationDisposals(fake: FakePlugin): () => number {
  const raw = fake.ctx as unknown as {
    rpc: { register: (definition: unknown, handlers: unknown) => Promise<{ dispose: () => Promise<void> }> }
  }
  let disposals = 0
  const register = raw.rpc.register.bind(raw.rpc)
  raw.rpc.register = async (definition, rpcHandlers) => {
    const created = await register(definition, rpcHandlers)
    return {
      ...created,
      dispose: async (): Promise<void> => {
        disposals++
        await created.dispose()
      },
    }
  }
  return () => disposals
}

/** Makes the fake's shell-hook registration fail — a real failure before `registerRunRpc`. */
function failShellHook(fake: FakePlugin): void {
  ;(fake.ctx as unknown as { shell: { hook: () => Promise<never> } }).shell.hook =
    () => Promise.reject(new Error("shell hook register failed"))
}

describe("setup rollback", () => {
  test("a registration failure before RPC leaves no activation and no handler table", async () => {
    const fake = makeFakePlugin(),
     disposals = countRegistrationDisposals(fake)
    failShellHook(fake)
    await expect(plugin.setup(fake.ctx)).rejects.toThrow(/shell hook register failed/u)
    expect(getCoordinator().projects.get("project-1")?.activations.size ?? 0).toBe(0)
    // RPC was never registered, so there is nothing to dispose.
    expect(disposals()).toBe(0)
  })

  test("a failed replacement reload leaves the live activation and its grace timer untouched", async () => {
    const first = await start(),
     projectKey = "project-1",
     previous = getCoordinator().projects.get(projectKey)?.activations.get("/work")
    expect(previous).toBeDefined()
    try {
      const replacement = makeFakePlugin(),
       disposals = countRegistrationDisposals(replacement)
      failShellHook(replacement)
      await expect(plugin.setup(replacement.ctx)).rejects.toThrow(/shell hook register failed/u)

      // The failed replacement never reached `activateLocation`: the live generation stands, its
      // event stream is not aborted, and no RPC registration was created to dispose.
      const current = getCoordinator().projects.get(projectKey)?.activations.get("/work")
      expect(current).toBe(previous)
      expect(current?.generationId).toBe(previous?.generationId)
      expect(current?.abortController.signal.aborted).toBe(false)
      expect(disposals()).toBe(0)
    } finally {
      await first.cleanup()
    }
  })

  test("a synchronous failure after RPC registration disposes it and leaves no activation", async () => {
    const fake = makeFakePlugin(),
     coordinator = getCoordinator(),
     disposals = countRegistrationDisposals(fake),
     patched = coordinator as unknown as { activateLocation: RuntimeCoordinator["activateLocation"] }
    patched.activateLocation = () => {
      throw new Error("activation boom")
    }
    try {
      await expect(plugin.setup(fake.ctx)).rejects.toThrow(/activation boom/u)
      expect(disposals()).toBe(1)
      expect(coordinator.projects.get("project-1")?.activations.size ?? 0).toBe(0)
    } finally {
      delete (coordinator as unknown as Record<string, unknown>)["activateLocation"]
    }
  })
})

describe("zero-token orphan interceptor", () => {
  test("a stale ultraopen child gets no tools, is interrupted, and is denied permission", async () => {
    const started = await start({
      sessions: {
        orphan: {
          id: "orphan",
          projectID: "project-1",
          location: { directory: "/work" },
          tokens: { output: 0 },
          metadata: { ultraopen: { bootId: "old-boot", runId: "run-old" } },
        },
      },
    })
    try {
      const event = {
        sessionID: "orphan",
        agent: "build",
        system: [],
        messages: [],
        tools: { edit: { description: "", input: {} } },
      }
      await started.fake.hook("session", "context", event)
      expect(event.tools as Record<string, unknown>).toEqual({})
      await waitFor(() => started.fake.interrupted.includes("orphan"), "the orphan interrupt")
      const permission = { sessionID: "orphan", action: "edit", resources: ["/work/a"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", permission)
      expect(permission.effect).toBe("deny")
    } finally {
      await started.cleanup()
    }
  })
})

describe("shell recursion containment", () => {
  test("a child shell invoking opencode is blocked before creation", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      await expect(
        started.fake.hook("tool", "execute.before", {
          tool: "shell",
          sessionID: "child",
          input: { command: "opencode run 'hi'" },
        }),
      ).rejects.toThrow(/another opencode process/u)
    } finally {
      await started.cleanup()
    }
  })

  test("a legitimate child shell sets ULTRAOPEN_ACTIVE=1 only for its own creation", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      await started.fake.hook("tool", "execute.before", {
        tool: "shell",
        sessionID: "child",
        input: { command: "ls -la", cwd: "/work" },
      })
      const childShell = { command: "ls -la", cwd: "/work", env: {} as Record<string, string | undefined> }
      await started.fake.hook("shell", "create.before", childShell)
      expect(childShell.env["ULTRAOPEN_ACTIVE"]).toBe("1")

      // A user shell with a different command never sees the marker.
      const userShell = { command: "git status", cwd: "/work", env: {} as Record<string, string | undefined> }
      await started.fake.hook("shell", "create.before", userShell)
      expect(userShell.env["ULTRAOPEN_ACTIVE"]).toBeUndefined()
    } finally {
      await started.cleanup()
    }
  })

  test("a child cannot call workflow/workflow_status/subagent/todowrite", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child", { disallowedTools: ["edit"] })
      for (const tool of [WORKFLOW_TOOL, STATUS_TOOL, "subagent", "todowrite", "edit"]) {
        await expect(
          started.fake.hook("tool", "execute.before", { tool, sessionID: "child", input: {} }),
        ).rejects.toThrow(/not available inside/u)
      }
    } finally {
      await started.cleanup()
    }
  })
})

describe("stale pending approval revocation (#149)", () => {
  test("a parent switching to a tighter agent rejects a pending child edit", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        {
          id: "plan",
          name: "plan",
          mode: "primary",
          hidden: false,
          permissions: [{ action: "edit", resource: "*", effect: "deny" }],
        },
      ],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "plan" },
      },
      pendingPermissions: { child: [{ id: "perm-1", action: "edit", resources: ["/work/a.ts"] }] },
    })
    try {
      ownChild(started.coordinator, "child")
      registerPending(started.coordinator, {
        runId: "run-1",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
      })
      started.fake.events.push({ type: "session.agent.selected", data: { sessionID: "parent" } })
      await waitFor(() => started.fake.replies.some((reply) => reply.requestID === "perm-1"), "the revocation")
      const reply = started.fake.replies.find((entry) => entry.requestID === "perm-1")
      expect(reply?.decision).toBe("reject")
    } finally {
      await started.cleanup()
    }
  })

  test("a failed revocation reply is swallowed so the event loop survives", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        {
          id: "plan",
          name: "plan",
          mode: "primary",
          hidden: false,
          permissions: [{ action: "edit", resource: "*", effect: "deny" }],
        },
      ],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "plan" },
      },
      pendingPermissions: { child: [{ id: "perm-1", action: "edit", resources: ["/work/a.ts"] }] },
    })
    try {
      ownChild(started.coordinator, "child")
      registerPending(started.coordinator, {
        runId: "run-1",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
      })
      const raw = started.fake.ctx as unknown as { permission: { reply: () => Promise<never> } }
      let attempts = 0
      raw.permission.reply = () => {
        attempts++
        return Promise.reject(new Error("reply transport failed"))
      }
      started.fake.events.push({ type: "session.agent.selected", data: { sessionID: "parent" } })
      await waitFor(() => attempts > 0, "the failed revocation attempt")
    } finally {
      await started.cleanup()
    }
  })

  test("agent.updated triggers stale pending permission revocation across live children", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        {
          id: "plan",
          name: "plan",
          mode: "primary",
          hidden: false,
          permissions: [{ action: "edit", resource: "*", effect: "deny" }],
        },
      ],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "plan" },
      },
      pendingPermissions: { child: [{ id: "perm-1", action: "edit", resources: ["/work/a.ts"] }] },
    })
    try {
      ownChild(started.coordinator, "child")
      registerPending(started.coordinator, {
        runId: "run-1",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
      })
      // An agent definition change is GLOBAL: every owned child re-evaluates its live chain.
      started.fake.events.push({ type: "agent.updated", data: {} })
      await waitFor(() => started.fake.replies.some((reply) => reply.requestID === "perm-1"), "the revocation")
      expect(started.fake.replies.find((entry) => entry.requestID === "perm-1")?.decision).toBe("reject")
    } finally {
      await started.cleanup()
    }
  })
})

/** The first RPC registration's handlers, as the plugin registered them. */
function handlers(fake: FakePlugin): FakeRpcCall["handlers"] {
  const call = fake.rpcCalls[0]
  if (call === undefined) {throw new Error("no RPC registration")}
  return call.handlers
}

describe("RPC", () => {
  test("listRuns combines live coordinator runs and disk manifests", async () => {
    const started = await start()
    try {
      registerPending(started.coordinator, {
        runId: "wf_live0001",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
        name: "live-demo",
      })
      await writeRunningRun("wf_disk0001", "parent")
      await writeFile(
        artifactPaths("wf_disk0001").progressPath,
        JSON.stringify({ runId: "wf_disk0001", workflow: "disk-demo", sessionID: "parent", status: "running", agents: [], logs: [], startedAt: 5 }),
        "utf8",
      )
      const output = await handlers(started.fake)["listRuns"]?.({}, rpcContext()) as { runs: { runId: string; workflow: string }[] }
      expect(output.runs.map((run) => run.runId)).toContain("wf_live0001")
      expect(output.runs.map((run) => run.runId)).toContain("wf_disk0001")
      const live = output.runs.find((run) => run.runId === "wf_live0001")
      expect(live?.workflow).toBe("live-demo")
      dropSettled(started.coordinator, "wf_live0001")
    } finally {
      await started.cleanup()
    }
  })

  test("includeHints is consumed once", async () => {
    const started = await start()
    try {
      await writeRunningRun("wf_hint0001", "parent")
      await writeFile(join(artifactPaths("wf_hint0001").dir, "interrupted.txt"), "wf_hint0001", "utf8")
      const first = await handlers(started.fake)["listRuns"]?.({ includeHints: true }, rpcContext()) as { hints?: { runId: string }[] }
      expect(first.hints?.map((hint) => hint.runId)).toEqual(["wf_hint0001"])
      const second = await handlers(started.fake)["listRuns"]?.({ includeHints: true }, rpcContext()) as { hints?: unknown[] }
      expect(second.hints).toBeUndefined()
    } finally {
      await started.cleanup()
    }
  })

  test("stopRun uses the confirmed stop path and emits runUpdated", async () => {
    const started = await start()
    try {
      await writeRunningRun("wf_stop0001", "parent")
      registerPending(started.coordinator, {
        runId: "wf_stop0001",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
      })
      const output = await handlers(started.fake)["stopRun"]?.({ runId: "wf_stop0001" }, rpcContext()) as { outcome: string }
      expect(output.outcome).toBe("stopped")
      const stopped = await readManifest("wf_stop0001")
      expect(stopped?.status).toBe("cancelled")
      await waitFor(() => started.fake.emitted.some((event) => event.name === "runUpdated"), "the runUpdated event")
    } finally {
      await started.cleanup()
    }
  })

  test("stopRun maps an unknown id to the typed not_found error", async () => {
    const started = await start()
    try {
      const output = await handlers(started.fake)["stopRun"]?.({ runId: "wf_nomatch01" }, rpcContext()) as { type: string }
      expect(output.type).toBe("not_found")
    } finally {
      await started.cleanup()
    }
  })
})

describe("launch gates", () => {
  test("a second launch from one non-ultracode session is refused", async () => {
    const started = await start()
    try {
      registerPending(started.coordinator, {
        runId: "wf_gate0001",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
      })
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, background: true })
      expect(String(result.content)).toContain("<workflow-refused>")
      expect(String(result.content)).toContain("already has a workflow run in flight")
      expect(started.fake.assertCalls).toHaveLength(0)
      dropSettled(started.coordinator, "wf_gate0001")
    } finally {
      await started.cleanup()
    }
  })

  test("a malformed resume id is refused before the permission ask", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, resumeFromRunId: "../../etc" })
      expect(String(result.content)).toContain("not a valid run id")
      expect(started.fake.assertCalls).toHaveLength(0)
    } finally {
      await started.cleanup()
    }
  })

  test("a well-formed missing resume id is refused before the ask", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, resumeFromRunId: "wf_nomach1" })
      expect(String(result.content)).toContain("No run exists")
      expect(started.fake.assertCalls).toHaveLength(0)
    } finally {
      await started.cleanup()
    }
  })

  test("a foreign-session resume is refused before the ask", async () => {
    const started = await start()
    try {
      await writeRunningRun("wf_foreign01", "someone-else")
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, resumeFromRunId: "wf_foreign01" })
      expect(String(result.content)).toContain("different session")
      expect(started.fake.assertCalls).toHaveLength(0)
    } finally {
      await started.cleanup()
    }
  })

  test("a subagent caller is refused without launching", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(
        WORKFLOW_TOOL,
        { script: `${META}return 1\n`, background: true },
        { agent: "explore" },
      )
      expect(String(result.content)).toContain("only to primary agents")
      expect(started.fake.assertCalls).toHaveLength(0)
    } finally {
      await started.cleanup()
    }
  })

  test("a dry run leaves no run directory behind", async () => {
    const started = await start()
    try {
      const before = new Set(await listRoot())
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, dryRun: true })
      expect(String(result.content)).toContain("<result")
      const after = await listRoot()
      expect(after.filter((name) => !before.has(name))).toEqual([])
    } finally {
      await started.cleanup()
    }
  })
})

describe("launch contract coverage", () => {
  test("the stop path renders the confirmed stop", async () => {
    const started = await start()
    try {
      await writeRunningRun("wf_stop0002", "parent")
      registerPending(started.coordinator, {
        runId: "wf_stop0002",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
        name: "demo",
      })
      const result = await started.fake.runTool(WORKFLOW_TOOL, { stop: "wf_stop0002" })
      expect(String(result.content)).toContain('<workflow-stopped run="wf_stop0002">')
    } finally {
      await started.cleanup()
    }
  })

  test("a persisted scriptPath is read and run", async () => {
    const started = await start()
    try {
      await ensureRunDir("wf_pathdemo01")
      const path = await writeScript("wf_pathdemo01", `${META}return 'from disk'\n`)
      const result = await started.fake.runTool(WORKFLOW_TOOL, { scriptPath: path, background: false })
      expect(String(result.content)).toContain("from disk")
    } finally {
      await started.cleanup()
    }
  })

  test("a failed default-model read degrades to no model rather than blocking the launch", async () => {
    const started = await start({ modelDefaultRejects: true })
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 'fine'\n`, background: false })
      expect(String(result.content)).toContain("fine")
    } finally {
      await started.cleanup()
    }
  })

  test("an unwritable run directory aborts the launch with no live entry", async () => {
    const saved = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = "/dev/null/nope"
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, background: true })
      expect(String(result.content)).toContain("could not be started")
      expect(started.coordinator.runs.size).toBe(0)
    } finally {
      await started.cleanup()
      if (saved === undefined) {delete process.env["XDG_DATA_HOME"]}
      else {process.env["XDG_DATA_HOME"] = saved}
    }
  })

  test("a broken saved workflow is noted and does not break the launch", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "ultraopen-cfg-")),
     saved = process.env["OPENCODE_CONFIG_DIR"]
    process.env["OPENCODE_CONFIG_DIR"] = configHome
    try {
      const dir = join(configHome, "ultraopen", "workflows")
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "broken.js"), "this is not a workflow", "utf8")
      const started = await start()
      try {
        const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 'ok'\n`, background: false })
        expect(String(result.content)).toContain("ok")
        expect(String(result.content)).toContain("<scan-notes>")
      } finally {
        await started.cleanup()
      }
    } finally {
      if (saved === undefined) {delete process.env["OPENCODE_CONFIG_DIR"]}
      else {process.env["OPENCODE_CONFIG_DIR"] = saved}
      await rm(configHome, { recursive: true, force: true })
    }
  })

  test("a blocking run that fails mid-flight returns the failure text", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}await agent('a')\nthrow new Error('boom mid-run')\n`,
        background: false,
      })
      expect(String(result.content)).toContain("boom mid-run")
      expect(String(result.content)).toContain("run id=")
    } finally {
      await started.cleanup()
    }
  })

  test("a same-session resume replays the journal", async () => {
    const started = await start()
    try {
      const script = `${META}await agent('a')\nreturn 'first'\n`,
       first = await started.fake.runTool(WORKFLOW_TOOL, { script, background: false }),
       runId = runIdOf(String(first.content))
      const resumed = await started.fake.runTool(
        WORKFLOW_TOOL,
        { script, resumeFromRunId: runId, background: false },
        { sessionID: "parent" },
      )
      expect(String(resumed.content)).toContain("<result")
    } finally {
      await started.cleanup()
    }
  })

  test("an ultracode session at its live-run cap is refused naming every run", async () => {
    const started = await start({}, { ultracodeMaxRuns: 1 })
    try {
      const project = started.coordinator.projectOf({ directory: "/work", project: { id: "project-1", canonical: "/work" } })
      project.mode.enable("parent", "command")
      registerPending(started.coordinator, {
        runId: "wf_cap00001",
        sessionID: "parent",
        projectKey: "project-1",
        locationDir: "/work",
      })
      const result = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, background: true })
      expect(String(result.content)).toContain("live-run cap of 1")
      expect(String(result.content)).toContain("wf_cap00001")
      dropSettled(started.coordinator, "wf_cap00001")
    } finally {
      await started.cleanup()
    }
  })

  test("zero-value decorations and dual sources are refused before the ask", async () => {
    const started = await start()
    try {
      const args = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, args: "null" })
      expect(String(args.content)).toContain("zero-value decoration")
      const scriptPath = await started.fake.runTool(WORKFLOW_TOOL, { scriptPath: "undefined" })
      expect(String(scriptPath.content)).toContain("zero-value decoration")
      const both = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, scriptPath: "/x.js" })
      expect(String(both.content)).toContain("Both `script` and `scriptPath`")
      const stringified = await started.fake.runTool(WORKFLOW_TOOL, { script: `${META}return 1\n`, args: "{bad" })
      expect(String(stringified.content)).toContain("JSON")
      expect(started.fake.assertCalls).toHaveLength(0)
    } finally {
      await started.cleanup()
    }
  })

  test("a configured size guideline is appended to the tool description", async () => {
    const started = await start({}, { sizeGuideline: "Keep fan-out under ten agents." })
    try {
      const description = String(started.fake.tools.get(WORKFLOW_TOOL)?.description)
      expect(description).toContain("Keep fan-out under ten agents.")
    } finally {
      await started.cleanup()
    }
  })
  test("a saved workflow added mid-session refreshes the command surface on the next launch", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "ultraopen-cfg-")),
     saved = process.env["OPENCODE_CONFIG_DIR"]
    process.env["OPENCODE_CONFIG_DIR"] = configHome
    try {
      const started = await start()
      try {
        const dir = join(configHome, "ultraopen", "workflows")
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, "late.js"),
          "export const meta = { name: 'late', description: 'Late' }\nreturn 'late-value'\n",
          "utf8",
        )
        const result = await started.fake.runTool(WORKFLOW_TOOL, {
          script: `${META}return await workflow('late')\n`,
          background: false,
        })
        expect(String(result.content)).toContain("late-value")
        expect(started.fake.commands.has("workflow-late")).toBe(true)
      } finally {
        await started.cleanup()
      }
    } finally {
      if (saved === undefined) {delete process.env["OPENCODE_CONFIG_DIR"]}
      else {process.env["OPENCODE_CONFIG_DIR"] = saved}
      await rm(configHome, { recursive: true, force: true })
    }
  })

  test("a dry run that fails renders bare and leaves no artifacts", async () => {
    const started = await start()
    try {
      const before = new Set(await listRoot())
      const result = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}throw new Error('dry boom')\n`,
        dryRun: true,
      })
      expect(String(result.content)).toContain("dry boom")
      expect(String(result.content)).not.toContain("run id=")
      const after = await listRoot()
      expect(after.filter((name) => !before.has(name))).toEqual([])
    } finally {
      await started.cleanup()
    }
  })

  test("a decorated resume id is refused before the ask and before any run dir", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}return 1\n`,
        resumeFromRunId: "null",
      })
      expect(String(result.content)).toContain("zero-value decoration")
      expect(started.fake.assertCalls).toHaveLength(0)
    } finally {
      await started.cleanup()
    }
  })

  test("a dry run can replay a completed run's journal", async () => {
    const started = await start()
    try {
      const script = `${META}await agent('a')\nreturn 'first'\n`,
       first = await started.fake.runTool(WORKFLOW_TOOL, { script, background: false }),
       runId = runIdOf(String(first.content))
      const dry = await started.fake.runTool(WORKFLOW_TOOL, { script, resumeFromRunId: runId, dryRun: true })
      expect(String(dry.content)).toContain("<result")
      expect(String(dry.content)).toContain("not queryable")
    } finally {
      await started.cleanup()
    }
  })

  test("a dry run with scriptPath reads the persisted script", async () => {
    const started = await start()
    try {
      await ensureRunDir("wf_drypath01")
      const path = await writeScript("wf_drypath01", `${META}return 'dry-from-disk'\n`)
      const result = await started.fake.runTool(WORKFLOW_TOOL, { scriptPath: path, dryRun: true })
      expect(String(result.content)).toContain("dry-from-disk")
    } finally {
      await started.cleanup()
    }
  })

  test("a stringified JSON args value is hydrated and noted", async () => {
    const started = await start()
    try {
      const result = await started.fake.runTool(WORKFLOW_TOOL, {
        script: `${META}return args.topic\n`,
        args: '{"topic":"hydrated"}',
        background: false,
      })
      expect(String(result.content)).toContain("hydrated")
      expect(String(result.content)).toContain("hydrated to object")
    } finally {
      await started.cleanup()
    }
  })

  test("a dropped event stream re-subscribes instead of ending the activation", async () => {
    const started = await start()
    try {
      started.fake.failNextSubscribe()
      // The loop catches the drop, waits out the retry delay, and keeps consuming.
      await new Promise((resolve) => {setTimeout(resolve, 320)})
      started.fake.events.push({ type: "session.status", data: { sessionID: "nobody" } })
    } finally {
      await started.cleanup()
    }
  })
})

describe("V2 hook paths", () => {
  test("the prompt hook turns on ultracode and stamps the message id", async () => {
    const started = await start()
    try {
      const event = {
        sessionID: "s1",
        messageID: "msg_prompt1",
        prompt: { text: "ultracode this audit" },
        metadata: undefined as Record<string, unknown> | undefined,
      }
      await started.fake.hook("session", "prompt", event)
      const project = started.coordinator.projectOf({ directory: "/work", project: { id: "project-1", canonical: "/work" } })
      expect(project.mode.isActive("s1")).toBe(true)
      expect(event.metadata).toEqual({ ultraopenMsgID: "msg_prompt1" })
    } finally {
      await started.cleanup()
    }
  })

  test("the model-resolve hook raises effort for a primary request", async () => {
    const started = await start({
      models: [{ id: "m", providerID: "p", variants: [{ id: "xhigh" }] }],
    })
    try {
      const project = started.coordinator.projectOf({ directory: "/work", project: { id: "project-1", canonical: "/work" } })
      project.mode.enable("s1", "keyword")
      const event: {
        sessionID: string
        agent: string
        kind: string
        model: { providerID: string; id: string; variant?: string }
      } = { sessionID: "s1", agent: "build", kind: "primary", model: { providerID: "p", id: "m" } }
      await started.fake.hook("session", "experimental.model.resolve", event)
      expect(event.model.variant).toBe("xhigh")
    } finally {
      await started.cleanup()
    }
  })

  test("the context hook appends reminders on an ordinary session", async () => {
    const started = await start({
      sessions: { s1: { id: "s1", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "build" } },
    })
    try {
      const project = started.coordinator.projectOf({ directory: "/work", project: { id: "project-1", canonical: "/work" } })
      project.mode.enable("s1", "keyword")
      const event = {
        sessionID: "s1",
        agent: "build",
        system: [],
        messages: [{ role: "user" as const, id: "msg_1", content: [{ type: "text", text: "hi" }], metadata: { ultraopenMsgID: "msg_1" } }],
        tools: {},
      }
      await started.fake.hook("session", "context", event)
      expect(event.messages[0]?.content).toHaveLength(2)
    } finally {
      await started.cleanup()
    }
  })

  test("permission evaluate denies a child shell that invokes opencode", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      const event = { sessionID: "child", action: "shell", resources: ["opencode run x"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", event)
      expect(event.effect).toBe("deny")
    } finally {
      await started.cleanup()
    }
  })

  test("a normal user session's permission is left unchanged", async () => {
    const started = await start({
      sessions: { parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "build" } },
    })
    try {
      const event = { sessionID: "parent", action: "edit", resources: ["/work/a"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", event)
      expect(event.effect).toBe("allow")
    } finally {
      await started.cleanup()
    }
  })

  test("a live ancestor's wholly-disabled tool is stripped from the child's context", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        { id: "plan", name: "plan", mode: "primary", hidden: false, permissions: [{ action: "edit", resource: "*", effect: "deny" }] },
      ],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "plan" },
      },
    })
    try {
      ownChild(started.coordinator, "child")
      const event = {
        sessionID: "child",
        agent: "build",
        system: [],
        messages: [],
        tools: { edit: { description: "", input: {} }, read: { description: "", input: {} } },
      }
      await started.fake.hook("session", "context", event)
      expect("edit" in event.tools).toBe(false)
      expect("read" in event.tools).toBe(true)
    } finally {
      await started.cleanup()
    }
  })

  test("an owned child whose ancestor chain cannot resolve is denied", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      const event = { sessionID: "child", action: "edit", resources: ["/work/a"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", event)
      // No parent session row exists, so the walk fails closed instead of widening the child.
      expect(event.effect).toBe("deny")
    } finally {
      await started.cleanup()
    }
  })

  test("a saved Allow always survives an ancestor ask when the child configured ask", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        { id: "asker", name: "asker", mode: "primary", hidden: false, permissions: [{ action: "edit", resource: "*", effect: "ask" }] },
      ],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "asker" },
        child: {
          id: "child",
          projectID: "project-1",
          location: { directory: "/work" },
          tokens: { output: 0 },
          agent: "build",
          permissions: [{ action: "edit", resource: "*", effect: "ask" }],
        },
      },
    })
    try {
      ownChild(started.coordinator, "child")
      const event = { sessionID: "child", action: "edit", resources: ["/work/a"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", event)
      // The user already answered this exact ask with "Allow always"; the ancestor only asks too.
      expect(event.effect).toBe("allow")
    } finally {
      await started.cleanup()
    }
  })

  test("an ancestor ask escalates a child allow the user has not saved", async () => {
    const started = await start({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [{ action: "edit", resource: "*", effect: "allow" }] },
        { id: "asker", name: "asker", mode: "primary", hidden: false, permissions: [{ action: "edit", resource: "*", effect: "ask" }] },
      ],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "asker" },
        child: { id: "child", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 }, agent: "build" },
      },
    })
    try {
      ownChild(started.coordinator, "child")
      const event = { sessionID: "child", action: "edit", resources: ["/work/a"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", event)
      expect(event.effect).toBe("ask")
    } finally {
      await started.cleanup()
    }
  })

  test("the default-agent fallback resolves a parent session with no agent", async () => {
    const started = await start({
      agents: [{ id: "plan", name: "plan", mode: "primary", hidden: false, permissions: [] }],
      sessions: {
        parent: { id: "parent", projectID: "project-1", location: { directory: "/work" }, tokens: { output: 0 } },
      },
    })
    try {
      ownChild(started.coordinator, "child")
      const event = { sessionID: "child", action: "edit", resources: ["/work/a"], effect: "allow" as "allow" | "deny" | "ask" }
      await started.fake.hook("permission", "evaluate", event)
      // The default agent contributes the host's default `ask`; the point is that the walk resolved it.
      expect(event.effect).toBe("ask")
    } finally {
      await started.cleanup()
    }
  })

  test("execute.after clears a shell token the creation hook never consumed", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      await started.fake.hook("tool", "execute.before", { tool: "shell", sessionID: "child", input: { command: "ls" } })
      await started.fake.hook("tool", "execute.after", { tool: "shell", sessionID: "child", input: { command: "ls" } })
      const shell = { command: "ls", cwd: "/work", env: {} as Record<string, string | undefined> }
      await started.fake.hook("shell", "create.before", shell)
      expect(shell.env["ULTRAOPEN_ACTIVE"]).toBeUndefined()
    } finally {
      await started.cleanup()
    }
  })

  test("the tool hook tolerates a malformed shell input", async () => {
    const started = await start()
    try {
      ownChild(started.coordinator, "child")
      await started.fake.hook("tool", "execute.before", { tool: "shell", sessionID: "child", input: {} })
      await started.fake.hook("tool", "execute.after", { tool: "shell", sessionID: "child", input: {} })
    } finally {
      await started.cleanup()
    }
  })
})

describe("reload handoff and explicit disable", () => {
  test("a replacement setup preserves live runs; an explicit disable stops only its scope's run", async () => {
    const first = await start()
    await writeRunningRun("wf_handoff01", "parent")
    registerPending(first.coordinator, {
      runId: "wf_handoff01",
      sessionID: "parent",
      projectKey: "project-1",
      locationDir: "/work",
    })
    // A run in another location must survive this location's disable.
    await writeRunningRun("wf_otherloc1", "parent")
    registerPending(first.coordinator, {
      runId: "wf_otherloc1",
      sessionID: "parent",
      projectKey: "project-1",
      locationDir: "/elsewhere",
    })

    await first.cleanup()
    const second = await start()
    try {
      // The replacement cancelled the handoff timer; the run is still live.
      await new Promise((resolve) => {setTimeout(resolve, 50)})
      expect(first.coordinator.runs.has("wf_handoff01")).toBe(true)
    } finally {
      await second.cleanup()
    }
    // The explicit disable's 2000ms grace has now started. Wait for it.
    await waitFor(async () => {
      const stopped = await readManifest("wf_handoff01")
      return stopped?.status === "cancelled"
    }, "the scoped disable")
    const other = await readManifest("wf_otherloc1")
    expect(other?.status).toBe("running")
  }, 10_000)
})
