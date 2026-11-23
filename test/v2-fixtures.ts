import type { Plugin } from "@opencode/plugin"

/**
 * A structural fake of the V2 plugin context.
 *
 * It records every transform, hook and RPC handler so tests can drive the REAL composition root
 * (`src/server/index.ts`) without a live opencode server. The fake is intentionally faithful to
 * the call shapes the adapter and transforms use — not a mock of our own modules.
 */

export interface FakeRule {
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
}

export interface FakeAgent {
  id: string
  name: string
  mode: "primary" | "subagent" | "all"
  hidden: boolean
  permissions: FakeRule[]
  description?: string
  system?: string
}

export interface FakeModel {
  id: string
  providerID: string
  variants: { id: string }[]
}

export interface FakeSession {
  id: string
  projectID: string
  location: { directory: string }
  tokens: { output: number }
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  permissions?: FakeRule[]
  metadata?: Record<string, unknown>
  outcome?: "succeeded" | "failed" | "interrupted"
}

export interface FakeToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  options?: { codemode?: boolean }
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

export interface FakeCommandDef {
  name: string
  description?: string
  execute: (input: {
    sessionID: string
    prompt: { text: string }
    delivery: "steer" | "queue"
  }) => Promise<void>
}

export interface FakeSkillDef {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

export interface FakePrompt {
  sessionID: string
  id?: string | null
  text: string
  delivery?: "steer" | "queue" | null
}

export interface FakeRpcCall {
  definition: { id: string; methods: Record<string, unknown> }
  handlers: Record<string, (input: unknown, context: FakeRpcContext) => Promise<unknown>>
}

export interface FakeRpcContext {
  signal: AbortSignal
  error: (type: string, message: string, data?: unknown) => { type: string; message: string; data?: unknown }
}

export interface FakeEvent {
  id?: string
  type: string
  data: Record<string, unknown>
}

export interface FakeOptions {
  directory?: string
  canonical?: string
  projectID?: string
  agents?: FakeAgent[]
  models?: FakeModel[]
  defaultModel?: FakeModel | undefined
  sessions?: Record<string, FakeSession>
  pendingPermissions?: Record<string, { id: string; action: string; resources: string[] }[]>
  assertPermission?: ((input: unknown) => Promise<void>) | undefined
  /** When true, `ctx.model.default()` rejects, exercising the launch's model-read degradation. */
  modelDefaultRejects?: boolean | undefined
}

export interface FakePlugin {
  ctx: Plugin.Context
  readonly location: { directory: string; project: { id: string; canonical: string } }
  readonly agents: FakeAgent[]
  readonly commands: Map<string, FakeCommandDef>
  readonly skills: Map<string, FakeSkillDef>
  readonly tools: Map<string, FakeToolDef>
  readonly sessionHooks: Map<string, ((input: unknown) => unknown)[]>
  readonly permissionHooks: Map<string, ((input: unknown) => unknown)[]>
  readonly toolHooks: Map<string, ((input: unknown) => unknown)[]>
  readonly shellHooks: Map<string, ((input: unknown) => unknown)[]>
  readonly prompts: FakePrompt[]
  readonly assertCalls: unknown[]
  readonly replies: { sessionID: string; requestID: string; decision: string; message?: string }[]
  readonly interrupted: string[]
  readonly rpcCalls: FakeRpcCall[]
  readonly emitted: { name: string; data: unknown }[]
  readonly events: FakeEvent[]
  /** Makes the next subscription iteration throw, exercising the loop's re-subscribe path. */
  failNextSubscribe: () => void
  /** The cleanup `setup` returned, once a test has called it. */
  cleanup?: (() => Promise<void> | void) | undefined
  reloadCommands: () => Promise<void>
  runTool: (name: string, input: unknown, context?: Record<string, unknown>) => Promise<FakeToolResult>
  hook: (kind: "session" | "permission" | "tool" | "shell", name: string, input: unknown) => Promise<unknown>
}

export interface FakeToolResult {
  content?: string | { type: string; text: string }[]
  metadata?: Record<string, unknown>
}

const defaultAgents = (): FakeAgent[] => [
  { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
  { id: "plan", name: "plan", mode: "primary", hidden: false, permissions: [] },
  { id: "explore", name: "explore", mode: "subagent", hidden: false, permissions: [] },
]

/**
 * Builds one structural plugin context.
 *
 * Agents are DEEP-cloned, so a transform in one test can never leak into another through a shared
 * seed array.
 */
export function makeFakePlugin(options: FakeOptions = {}): FakePlugin {
  const directory = options.directory ?? "/work",
   canonical = options.canonical ?? directory,
   projectID = options.projectID ?? "project-1",
   location = { directory, project: { id: projectID, canonical } },
   agents = structuredClone(options.agents ?? defaultAgents()),
   models = options.models ?? [],
   sessions = new Map(Object.entries(options.sessions ?? {})),
   pendingPermissions = new Map(Object.entries(options.pendingPermissions ?? {})),
   commands = new Map<string, FakeCommandDef>(),
   skills = new Map<string, FakeSkillDef>(),
   tools = new Map<string, FakeToolDef>(),
   sessionHooks = new Map<string, ((input: unknown) => unknown)[]>(),
   permissionHooks = new Map<string, ((input: unknown) => unknown)[]>(),
   toolHooks = new Map<string, ((input: unknown) => unknown)[]>(),
   shellHooks = new Map<string, ((input: unknown) => unknown)[]>(),
   prompts: FakePrompt[] = [],
   assertCalls: unknown[] = [],
   replies: FakePlugin["replies"] = [],
   interrupted: string[] = [],
   rpcCalls: FakeRpcCall[] = [],
   emitted: { name: string; data: unknown }[] = [],
   events: FakeEvent[] = []

  let defaultAgentID = "build"
  let failSubscribe = false

  const registration = { dispose: (): Promise<void> => Promise.resolve() }

  const recordHook = (
    map: Map<string, ((input: unknown) => unknown)[]>,
    name: string,
    handler: (input: unknown) => unknown,
  ): typeof registration => {
    const list = map.get(name) ?? []
    list.push(handler)
    map.set(name, list)
    return registration
  }

  const findAgent = (agentID: string | undefined): FakeAgent | undefined =>
    agentID === undefined ? agents.find((agent) => agent.id === defaultAgentID) : agents.find((agent) => agent.id === agentID)

  const commandEditor = {
    add: (definition: FakeCommandDef): void => {commands.set(definition.name, definition)},
  }

  let commandTransform: ((editor: typeof commandEditor) => void) | undefined

  const ctx = {
    location: { ...location, workspaceID: undefined },
    options: {},
    agent: {
      transform: (register: (editor: unknown) => void): Promise<typeof registration> => {
        const editor = {
          list: () => agents,
          get: (id: string) => agents.find((agent) => agent.id === id),
          default: (id: string | undefined) => {defaultAgentID = id ?? "build"},
          update: (id: string, update: (agent: FakeAgent) => void) => {
            let agent = agents.find((entry) => entry.id === id)
            if (agent === undefined) {
              agent = { id, name: id, mode: "primary", hidden: false, permissions: [] }
              agents.push(agent)
            }
            update(agent)
          },
          remove: (id: string) => {
            const index = agents.findIndex((agent) => agent.id === id)
            if (index !== -1) {agents.splice(index, 1)}
          },
        }
        register(editor)
        return Promise.resolve(registration)
      },
      get: (input: { agentID: string }) => {
        const agent = findAgent(input.agentID)
        if (agent === undefined) {return Promise.reject(new Error(`no agent ${input.agentID}`))}
        return Promise.resolve({ data: agent })
      },
      list: () => Promise.resolve({ data: agents }),
    },
    model: {
      list: () => Promise.resolve({ data: models }),
      default: () => {
        if (options.modelDefaultRejects === true) {return Promise.reject(new Error("model catalog unavailable"))}
        return Promise.resolve({ data: options.defaultModel ?? models[0] ?? null })
      },
    },
    command: {
      transform: (register: (editor: typeof commandEditor) => void): Promise<typeof registration> => {
        commandTransform = register
        register(commandEditor)
        return Promise.resolve(registration)
      },
      reload: (): Promise<void> => {
        commandTransform?.(commandEditor)
        return Promise.resolve()
      },
      list: () => Promise.resolve({ data: [...commands.values()] }),
    },
    skill: {
      transform: (register: (editor: { add: (skill: FakeSkillDef) => void }) => void): Promise<typeof registration> => {
        register({ add: (skill) => {skills.set(skill.name, skill)} })
        return Promise.resolve(registration)
      },
      list: () => Promise.resolve({ data: [...skills.values()] }),
    },
    tool: {
      transform: (register: (editor: {
        list: () => FakeToolDef[]
        get: (id: string) => FakeToolDef | undefined
        namespace: () => void
        add: (tool: FakeToolDef) => void
        update: (id: string, fn: (tool: FakeToolDef) => void) => void
        remove: (id: string) => void
      }) => void): Promise<typeof registration> => {
        register({
          list: () => [...tools.values()],
          get: (id) => tools.get(id),
          namespace: () => {},
          add: (tool) => {tools.set(tool.name, tool)},
          update: (id, fn) => {
            const tool = tools.get(id)
            if (tool !== undefined) {fn(tool)}
          },
          remove: (id) => {tools.delete(id)},
        })
        return Promise.resolve(registration)
      },
      reload: (): Promise<void> => Promise.resolve(),
      list: () => Promise.resolve([...tools.values()]),
      hook: (name: string, handler: (input: unknown) => unknown) =>
        Promise.resolve(recordHook(toolHooks, name, handler)),
    },
    session: {
      hook: (name: string, handler: (input: unknown) => unknown) =>
        Promise.resolve(recordHook(sessionHooks, name, handler)),
      get: (input: { sessionID: string }) => {
        const session = sessions.get(input.sessionID)
        if (session === undefined) {return Promise.reject(new Error(`no session ${input.sessionID}`))}
        return Promise.resolve(session)
      },
      create: (input: { metadata?: Record<string, unknown> }) => {
        const session: FakeSession = {
          id: `ses_child_${sessions.size}`,
          projectID,
          location: { directory },
          tokens: { output: 0 },
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }
        sessions.set(session.id, session)
        return Promise.resolve(session)
      },
      move: (): Promise<void> => Promise.resolve(),
      wait: (): Promise<void> => Promise.resolve(),
      context: (): Promise<FakeSession[]> => Promise.resolve([]),
      prompt: (input: FakePrompt) => {
        prompts.push(input)
        return Promise.resolve({ id: input.id ?? "inbox" })
      },
      synthetic: () => Promise.resolve({ admitted: true }),
      interrupt: (input: { sessionID: string }) => {
        interrupted.push(input.sessionID)
        return Promise.resolve({})
      },
    },
    permission: {
      assert: async (input: unknown): Promise<void> => {
        assertCalls.push(input)
        await options.assertPermission?.(input)
      },
      list: (input: { sessionID: string }) => Promise.resolve(pendingPermissions.get(input.sessionID) ?? []),
      get: () => Promise.resolve(undefined),
      reply: (input: { sessionID: string; requestID: string; decision: string; message?: string }) => {
        replies.push(input)
        return Promise.resolve()
      },
      hook: (name: string, handler: (input: unknown) => unknown) =>
        Promise.resolve(recordHook(permissionHooks, name, handler)),
    },
    shell: {
      hook: (name: string, handler: (input: unknown) => unknown) =>
        Promise.resolve(recordHook(shellHooks, name, handler)),
    },
    event: {
      subscribe: (subscribeOptions?: { signal?: AbortSignal }) => {
        const signal = subscribeOptions?.signal
        async function* streamEvents(): AsyncGenerator<FakeEvent> {
          for (;;) {
            if (signal?.aborted === true) {return}
            if (failSubscribe) {
              failSubscribe = false
              throw new Error("stream dropped")
            }
            const next = events.shift()
            if (next !== undefined) {
              yield next
              continue
            }
            await new Promise((resolve) => {setTimeout(resolve, 5)})
          }
        }
        return streamEvents()
      },
    },
    rpc: {
      register: (
        definition: FakeRpcCall["definition"],
        handlers: FakeRpcCall["handlers"],
      ) => {
        rpcCalls.push({ definition, handlers })
        return Promise.resolve({
          ...registration,
          events: {
            emit: (name: string, data: unknown) => {
              emitted.push({ name, data })
              return Promise.resolve()
            },
          },
        })
      },
    },
  }

  const fake: FakePlugin = {
    ctx: ctx as unknown as Plugin.Context,
    location,
    agents,
    commands,
    skills,
    tools,
    sessionHooks,
    permissionHooks,
    toolHooks,
    shellHooks,
    prompts,
    assertCalls,
    replies,
    interrupted,
    rpcCalls,
    emitted,
    events,
    failNextSubscribe: (): void => {failSubscribe = true},
    reloadCommands: async (): Promise<void> => {await ctx.command.reload()},
    runTool: async (name, input, context = {}): Promise<FakeToolResult> => {
      const tool = tools.get(name)
      if (tool === undefined) {throw new Error(`no tool ${name}`)}
      const signal = (context["signal"] as AbortSignal | undefined) ?? new AbortController().signal
      return await tool.execute(input, {
        sessionID: "parent",
        agent: "build",
        messageID: "msg_call",
        id: "call_1",
        signal,
        progress: (): Promise<void> => Promise.resolve(),
        ...context,
      }) as FakeToolResult
    },
    hook: async (kind, name, input): Promise<unknown> => {
      const hookMap = { session: sessionHooks, permission: permissionHooks, tool: toolHooks, shell: shellHooks }[kind]
      let current = input
      for (const handler of hookMap.get(name) ?? []) {
        current = await handler(current) ?? current
      }
      return current
    },
  }
  return fake
}

/** A fake RPC call context whose `error` factory returns the typed error object. */
export function rpcContext(): FakeRpcContext {
  return {
    signal: new AbortController().signal,
    error: (type, message, data) => ({ type, message, ...(data === undefined ? {} : { data }) }),
  }
}
