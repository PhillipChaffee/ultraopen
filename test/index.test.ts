import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { ultraopen } from "../src/server/index.js"
import { registry } from "../src/server/singleton.js"
import * as background from "../src/server/tool/background.js"
import { STATUS_TOOL, WORKFLOW_TOOL } from "../src/server/bridge/permission.js"
import { executeStatus } from "../src/server/tool/status.js"
import { mode } from "../src/server/ultracode/mode.js"
import type { MutableConfig } from "../src/server/ultracode/config.js"
import { ensureRunDir, readJournal, readManifest, writeScript } from "../src/server/resume/store.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Point run artifacts at a temp directory.
 *
 * The tool persists a manifest, journal, result and script per run. Without this the suite writes
 * real artifacts into the user's opencode data directory — ~27 stray run folders per `bun test`.
 */
let dataHome: string,
 savedDataHome: string | undefined

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "ultraopen-testdata-"))
  savedDataHome = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
})

afterAll(async () => {
  if (savedDataHome === undefined) {delete process.env["XDG_DATA_HOME"]}
  else {process.env["XDG_DATA_HOME"] = savedDataHome}
  await rm(dataHome, { recursive: true, force: true })
})


interface ToolDef {
  description: string
  args: Record<string, unknown>
  execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string>
}

const META = "export const meta = { name: 'demo', description: 'a demo workflow' }\n",

/** A client that never actually spawns — index tests exercise wiring, not the bridge. */
 stubClient = {
  config: {
    get: () => Promise.resolve({ data: {} }),
    providers: () => Promise.resolve({ data: { providers: [] } }),
  },
  session: {
    create: () => Promise.resolve({ data: { id: "child" } }),
    get: () => Promise.resolve({ data: { id: "child" } }),
    delete: () => Promise.resolve({}),
    abort: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ data: { info: {}, parts: [] } }),
  },
},

toolOf = (hooks: Record<string, unknown>): ToolDef | undefined => {
  const tools = hooks["tool"] as Record<string, ToolDef> | undefined
  return tools?.[WORKFLOW_TOOL]
 }

/**
 * Swaps process.argv around a callback.
 *
 * The host-aware launch contract reads argv at plugin-registration time, so a
 * test controls which contract the plugin serves by standing in the host's
 * argv. The shapes are the live captures documented in tool/background.ts.
 */
, withArgv = async (argv: string[], run: () => Promise<void> | void): Promise<void> => {
  const saved = process.argv
  process.argv = argv
  try { await run() } finally { process.argv = saved }
}

/** Bounded polling: used where a launch phase runs concurrently with the test. */
const waitFor = async (until: () => boolean | Promise<boolean>, what: string): Promise<void> => {
  for (let waited = 0; waited < 400; waited++) {
    if (await until()) {return}
    await new Promise((resolve) => {setTimeout(resolve, 5)})
  }
  throw new Error(`timed out waiting for ${what}`)
}

let savedEnv: string | undefined

beforeEach(() => {
  registry.resetForTests()
  background.resetForTests()
  mode.resetForTests()
  savedEnv = process.env["ULTRAOPEN_ACTIVE"]
  delete process.env["ULTRAOPEN_ACTIVE"]
})

afterEach(() => {
  if (savedEnv === undefined) {delete process.env["ULTRAOPEN_ACTIVE"]}
  else {process.env["ULTRAOPEN_ACTIVE"] = savedEnv}
})

describe("plugin registration", () => {
  test("registers the workflow tool under its bare id", () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    expect(tool).toBeDefined()
    expect(typeof tool?.execute).toBe("function")
    expect(tool?.description).toContain("orchestrates multiple subagents")
  })

  test("exposes a config hook and a shell.env hook", () => {
    const hooks = ultraopen({ client: stubClient })
    expect(typeof hooks["config"]).toBe("function")
    expect(typeof hooks["shell.env"]).toBe("function")
  })

  test("the args schema accepts title and description so a CC-trained model is not rejected", () => {
    // The spec says both are accepted and IGNORED. Omitting them would turn a harmless extra
    // argument into a schema validation error.
    const args = toolOf(ultraopen({ client: stubClient }))?.args ?? {}
    expect(Object.keys(args)).toContain("title")
    expect(Object.keys(args)).toContain("description")
    expect(Object.keys(args)).toContain("script")
    expect(Object.keys(args)).toContain("dryRun")
    // Resume is a headline feature; if the model cannot see the argument, it can never use it.
    expect(Object.keys(args)).toContain("resumeFromRunId")
  })

  test("applies the configured concurrency to the process-wide gate", () => {
    ultraopen({ client: stubClient }, { concurrency: 3 })
    expect(registry.semaphore.limit).toBe(3)
  })

  test("a concurrency of 0 is clamped rather than honoured", () => {
    // `0 ?? 8` is 0, and a limit below 1 makes every acquire wait forever with no throw.
    ultraopen({ client: stubClient }, { concurrency: 0 })
    expect(registry.semaphore.limit).toBeGreaterThanOrEqual(1)
  })
})

describe("host-aware launch contract", () => {
  test("a long-lived host frees the turn: the description and the launch result end it after launch", async () => {
    let tool: ToolDef | undefined,
      output = ""
    await withArgv(["bun", "/$bunfs/root/src/cli/tui/worker.js"], async () => {
      tool = toolOf(ultraopen({ client: stubClient }))
      if (!tool) {throw new Error("tool was not registered")}
      output = await tool.execute(
        { script: `${META}await agent('a')\nreturn 'LATE-VALUE'\n`, background: true },
        { sessionID: "parent" },
      )
    })
    expect(tool?.description).toContain("outlives your")
    expect(output).toContain("<workflow-launched")
    expect(output).toContain("end your turn and let it work")
    expect(output).not.toContain("Before ending your turn")
    expect(output).not.toContain("LATE-VALUE")
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await background.settlePromiseOf(runId)
  })

  test("a one-shot host keeps the hold-the-turn contract", async () => {
    let output = ""
    await withArgv(["bun", "/$bunfs/root/src/index.js", "run", "say hi"], async () => {
      const tool = toolOf(ultraopen({ client: stubClient }))
      if (!tool) {throw new Error("tool was not registered")}
      output = await tool.execute(
        { script: `${META}await agent('a')\nreturn 'LATE-VALUE'\n`, background: true },
        { sessionID: "parent" },
      )
    })
    expect(output).toContain("Before ending your turn, poll until the run settles")
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await background.settlePromiseOf(runId)
  })

  test("an explicit blocking runMode wins over a long-lived host", async () => {
    let description = ""
    await withArgv(["bun", "/$bunfs/root/src/cli/tui/worker.js"], () => {
      description = toolOf(ultraopen({ client: stubClient }, { runMode: "blocking" }))?.description ?? ""
    })
    expect(description).toContain("This call BLOCKS until the run completes")
    expect(description).not.toContain("outlives your")
  })

  test("the test runner's own argv is an unknown shape, so the pinned contract is the default", () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    expect(tool?.description).toContain("The run continues in the background while you keep")
  })
})

describe("nested-process guard", () => {
  test("does NOT register the tool when ULTRAOPEN_ACTIVE is set", () => {
    // A nested `opencode` gets a fresh server, plugin load and tool, escaping this process's
    // concurrency cap, agent counter, budget and abort signal. This guard survives every path a
    // bash command pattern cannot match.
    process.env["ULTRAOPEN_ACTIVE"] = "1"
    const hooks = ultraopen({ client: stubClient })
    expect(hooks["tool"]).toBeUndefined()
  })

  test("still installs config and hooks when nested", () => {
    process.env["ULTRAOPEN_ACTIVE"] = "1"
    const hooks = ultraopen({ client: stubClient })
    expect(typeof hooks["config"]).toBe("function")
    expect(typeof hooks["shell.env"]).toBe("function")
  })
})

describe("shell.env hook", () => {
  test("marks shells only inside engine-owned sessions", () => {
    const hooks = ultraopen({ client: stubClient }),
     hook = hooks["shell.env"] as (i: { sessionID?: string }, o: { env: Record<string, string> }) => void

    registry.register("child", "run-1")

    const owned = { env: {} as Record<string, string> }
    hook({ sessionID: "child" }, owned)
    expect(owned.env["ULTRAOPEN_ACTIVE"]).toBe("1")

    // Scoping matters: a blanket marker would disable the tool for the user's own work too.
    const foreign = { env: {} as Record<string, string> }
    hook({ sessionID: "someone-elses" }, foreign)
    expect(foreign.env["ULTRAOPEN_ACTIVE"]).toBeUndefined()

    const anonymous = { env: {} as Record<string, string> }
    hook({}, anonymous)
    expect(anonymous.env["ULTRAOPEN_ACTIVE"]).toBeUndefined()
  })
})

describe("config hook", () => {
  test("installs the ultracode agent, command and permission default", () => {
    const hooks = ultraopen({ client: stubClient }),
     config: MutableConfig = {}
    ;(hooks["config"] as (c: MutableConfig) => void)(config)

    expect(config.agent?.["ultracode"]).toBeDefined()
    expect(config.command?.["ultracode"]).toBeDefined()
    expect((config.permission as Record<string, unknown>)["workflow"]).toBe("ask")
    expect(config.experimental?.primary_tools).toContain(WORKFLOW_TOOL)
  })

  test("is synchronous — it must not return a promise", () => {
    // The hook's return value is discarded; mutation is the only channel. Awaiting the client
    // from inside it can cache an agent list built from the un-mutated config for the whole
    // instance lifetime.
    const hooks = ultraopen({ client: stubClient }),
     result = (hooks["config"] as (c: MutableConfig) => unknown)({})
    expect(result).toBeUndefined()
  })
})

describe("tool execution", () => {
  const run = async (args: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<string> => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    return await tool.execute(args, { sessionID: "parent", ...context })
  }

  test("renders a successful dry run with the value and usage", async () => {
    const output = await run({ script: `${META}return { ok: 1 }\n`, dryRun: true })
    expect(output).toContain(`<result workflow="demo"`)
    expect(output).toContain(`"ok": 1`)
    expect(output).toContain("<usage")
  })

  test("includes log lines emitted by the script", async () => {
    const output = await run({ script: `${META}log('hello from the script')\nreturn 1\n`, dryRun: true })
    expect(output).toContain("<log>")
    expect(output).toContain("hello from the script")
  })

  test("reports the agent count a dry run WOULD have spawned", async () => {
    // agentCount must reflect the fan-out even when nothing was really spawned, or dryRun cannot
    // be used to preview cost.
    const script = `${META}await parallel([() => agent('a'), () => agent('b'), () => agent('c')])\nreturn 'done'\n`
    expect(await run({ script, dryRun: true })).toContain('agents="3"')
  })

  test("asks for permission using the workflow's real name, not the ignored title arg", async () => {
    // The script is parsed BEFORE asking so the prompt can name the workflow. Using the `title`
    // argument would be wrong twice over: it is documented as ignored, and models omit it — which
    // showed up live as a permission prompt reading "null".
    const asked: Record<string, unknown>[] = []
    await run(
      { script: `${META}return 1\n`, dryRun: true, title: "ignored-title" },
      { ask: (request: Record<string, unknown>) => { asked.push(request); return Promise.resolve() } },
    )
    expect(asked.length).toBe(1)
    expect(asked[0]?.["permission"]).toBe(WORKFLOW_TOOL)
    expect(asked[0]?.["patterns"]).toEqual(["demo"])
    // NOT ["*"]: an "always" grant is stored instance-wide, so approving with "*" would
    // permanently disable the prompt for every workflow in the directory.
    expect(asked[0]?.["always"]).toEqual(["demo"])
  })

  test("the permission metadata describes what will run", async () => {
    const asked: Record<string, unknown>[] = [],
     script = "export const meta = { name: 'audit', description: 'Audit auth', phases: [{ title: 'Find' }] }\nreturn 1\n"
    await run(
      { script, dryRun: true },
      { ask: (request: Record<string, unknown>) => { asked.push(request); return Promise.resolve() } },
    )
    const metadata = asked[0]?.["metadata"] as Record<string, unknown>
    expect(metadata["name"]).toBe("audit")
    expect(metadata["description"]).toBe("Audit auth")
    expect(metadata["phases"]).toEqual(["Find"])
  })

  test("a script that fails to parse is rejected BEFORE the permission prompt", async () => {
    // No point asking the user to approve a run that cannot start.
    const asked: unknown[] = [],
     output = await run(
      { script: `${META}const x: string[] = []\n`, dryRun: true },
      { ask: (request: unknown) => { asked.push(request); return Promise.resolve() } },
    )
    expect(output).toContain("not TypeScript")
    expect(asked).toEqual([])
  })

  test("a parse failure comes back as a rendered diagnostic, not a crash", async () => {
    const output = await run({ script: `${META}const x: string[] = []\n`, dryRun: true })
    expect(output).toContain("ParseError")
    expect(output).toContain("not TypeScript")
    // The caret line proves the source was threaded through to the renderer.
    expect(output).toContain("^")
  })

  test("a missing script is reported clearly", async () => {
    expect(await run({ dryRun: true })).toContain("needs a `script`")
  })

  test("a persisted script can be re-run via scriptPath", async () => {
    // The schema advertises scriptPath; the execute path must actually read it, or the advertised
    // surface errors at runtime (verified live before this was wired).
    await ensureRunDir("wf_pathdemo01", undefined)
    const paths = await writeScript("wf_pathdemo01", `${META}return 'from disk'\n`)
    expect(await run({ scriptPath: paths, background: false })).toContain("from disk")
  })

  test("a failed run persists its PARTIAL journal so a resume can replay what succeeded", async () => {
    // Without this, endRun on failure wrote an empty journal and destroyed the replayable prefix
    // of agents that had already completed — resume would redo work it already paid for.
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const script = `${META}await agent('succeeds')\nthrow new Error('script blew up')\n`,
     output = await tool.execute({ script, background: false }, { sessionID: "parent" })
    expect(output).toContain("script blew up")

    // Find the run id from the tool's rendered failure — the journal is keyed by run.
    const runId = output.match(/id="(?<runId>[^"]+)"/u)?.[1]
    expect(runId).toBeDefined()
    const entries = await readJournal(runId ?? "")
    expect(entries.length).toBe(1)
    expect(entries[0]?.status).toBe("ok")
    const manifest = await readManifest(runId ?? "", undefined)
    expect(manifest?.status).toBe("failed")
  })

  test("a completed run persists its child sessions in the manifest", async () => {
    // The manifest's child list is what the startup reaper reads; if it were only read from the
    // registry after endRun — which abortAll has already cleared — it would always be []. This
    // pins the completed path (the capture happens inside the run, before its cleanup).
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const script = `${META}await agent('a')\nreturn 'done'\n`,
     output = await tool.execute({ script, background: false }, { sessionID: "parent" }),
     runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1]
    expect(runId).toBeDefined()
    const manifest = await readManifest(runId ?? "", undefined)
    expect(manifest?.childSessionIDs).toEqual(["child"])
  })

  test("a resume with changed args renders the args-changed note", async () => {
    // A replayed run must never read as a fresh one — this note is the visible marker that
    // nothing was replayed because the inputs changed.
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const script = `${META}await agent('a')\nreturn 'ok'\n`,

     first = await tool.execute({ script, args: { topic: "one" }, background: false }, { sessionID: "parent" }),
     runId = first.match(/run="(?<runId>[^"]+)"/u)?.[1]
    expect(runId).toBeDefined()

    const second = await tool.execute(
      { script, args: { topic: "two" }, resumeFromRunId: runId, background: false },
      { sessionID: "parent" },
    )
    expect(second).toContain('args changed since the previous run')
  })

  test("refuses to run inside a session the engine owns", async () => {
    registry.register("parent", "outer-run")
    expect(await run({ script: `${META}return 1\n`, dryRun: true })).toContain("cannot be called from inside")
  })

  test("surfaces failed agents rather than letting partial coverage read as full", async () => {
    // A client whose session.create never returns data, so every agent fails to spawn.
    const failing = { session: { ...stubClient.session, create: () => Promise.resolve({ error: "nope" }) } },
     tool = toolOf(ultraopen({ client: failing })),
     output = await tool?.execute(
      { script: `${META}await parallel([() => agent('a'), () => agent('b')])\nreturn 'done'\n`, background: false },
      { sessionID: "parent" },
    )
    expect(output).toContain("<failures")
    expect(output).toContain('of="2"')
  })
})

describe("model and effort wiring", () => {
  const catalogClient = {
    config: {
      get: () => Promise.resolve({ data: { model: "opencode/claude-sonnet-4-6" } }),
      providers: () =>
        Promise.resolve({
          data: {
            providers: [
              { id: "opencode", models: { "claude-sonnet-4-6": { variants: { low: {}, high: {}, max: {} } } } },
            ],
          },
        }),
    },
    session: {
      ...stubClient.session,
      prompt: () =>
        Promise.resolve({ data: { info: { tokens: { output: 1 } }, parts: [{ type: "text", text: "ok" }] } }),
    },
  }

  test("reads the session's default model and resolves effort against ITS variants", async () => {
    const tool = toolOf(ultraopen({ client: catalogClient })),
     script = `${META}await agent('x', { effort: 'xhigh' })\nreturn 'done'\n`,
     output = await tool?.execute({ script, background: false }, { sessionID: "parent" })

    // The model has no xhigh, so the request is downgraded — and the run log SAYS so, rather than
    // silently applying no extra thinking at all.
    expect(output).toContain("<log>")
    expect(output).toContain("unsupported")
    expect(output).toContain("high")
  })

  test("a client whose config.get fails still runs", async () => {
    const failing = {
      config: {
        get: () => Promise.reject(new Error("no config")),
        providers: () => Promise.resolve({ data: { providers: [] } }),
      },
      session: catalogClient.session,
    },
     tool = toolOf(ultraopen({ client: failing })),
     output = await tool?.execute({ script: `${META}return 'fine'\n`, background: false }, { sessionID: "parent" })
    expect(output).toContain("fine")
  })

  test("a dry run skips the catalog entirely", async () => {
    let fetched = false
    const watched = {
      config: {
        get: () => Promise.resolve({ data: { model: "opencode/claude-sonnet-4-6" } }),
        providers: () => {
          fetched = true
          return Promise.resolve({ data: { providers: [] } })
        },
      },
      session: stubClient.session,
    },
     tool = toolOf(ultraopen({ client: watched }))
    await tool?.execute({ script: `${META}return 1\n`, dryRun: true }, { sessionID: "parent" })
    expect(fetched).toBe(false)
  })
})

describe("startup orphan sweep", () => {
  test("a failing sweep never takes down plugin init", async () => {
    // The sweep runs in the background during init. A server that rejects an abort — or is not
    // reachable at all — must not stop the plugin from registering.
    const hostile = {
      config: stubClient.config,
      session: { ...stubClient.session, abort: () => Promise.reject(new Error("server down")) },
    },
     hooks = ultraopen({ client: hostile })
    expect(toolOf(hooks)).toBeDefined()
    // Let the detached sweep settle so an unhandled rejection would surface here.
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  })
})

describe("ultracode hooks are wired", () => {
  type Hook = (...args: never[]) => unknown
  const hookOf = (name: string): Hook => {
    const hooks = ultraopen({ client: stubClient })
    return hooks[name] as Hook
  }

  test("chat.message detects the keyword and raises effort", () => {
    const output = {
      message: { id: "m1", model: { variant: undefined as string | undefined } },
      parts: [{ type: "text", text: "ultracode this" }],
    }
    ;(hookOf("chat.message") as (i: unknown, o: unknown) => void)({ sessionID: "s1" }, output)
    expect(mode.isActive("s1")).toBe(true)
  })

  test("messages.transform injects the reminder once the mode is on", () => {
    const hook = hookOf("experimental.chat.messages.transform") as (i: unknown, o: unknown) => void
    mode.enable("s1", "keyword")
    const output = { messages: [{ info: { id: "m1", role: "user", sessionID: "s1" }, parts: [] as unknown[] }] }
    hook({}, output)
    expect(output.messages[0]?.parts.length).toBe(1)
  })

  test("chat.params merges the variant's provider options", () => {
    const hook = hookOf("chat.params") as (i: unknown, o: unknown) => void
    mode.enable("s1", "keyword")
    const output = { options: {} as Record<string, unknown> }
    hook({ sessionID: "s1", model: { variants: { xhigh: { thinking: "adaptive" } } } }, output)
    expect(output.options["thinking"]).toBe("adaptive")
  })

  test("/ultracode toggles the mode, and `off` turns it back off", () => {
    const hook = hookOf("command.execute.before") as (i: unknown) => void
    hook({ command: "ultracode", sessionID: "s1" })
    expect(mode.isActive("s1")).toBe(true)
    hook({ command: "ultracode", sessionID: "s1", arguments: "off" })
    expect(mode.isActive("s1")).toBe(false)
  })

  test("`off` is case-insensitive — `/ultracode OFF` must not re-enable", () => {
    const hook = hookOf("command.execute.before") as (i: unknown) => void
    hook({ command: "ultracode", sessionID: "s1" })
    hook({ command: "ultracode", sessionID: "s1", arguments: "OFF" })
    expect(mode.isActive("s1")).toBe(false)
  })

  test("other commands are ignored", () => {
    const hook = hookOf("command.execute.before") as (i: unknown) => void
    hook({ command: "init", sessionID: "s1" })
    expect(mode.isActive("s1")).toBe(false)
  })

  test("the plugin-options flag turns the mode on for fresh sessions", () => {
    ultraopen({ client: stubClient }, { ultracode: true })
    expect(mode.isActive("brand-new-session")).toBe(true)
  })
})

/** A message.part.updated event naming one session, the shape the event hook actually receives. */
const partEvent = (sessionID: string): { event: { type: string; properties: Record<string, unknown> } } => ({
  event: { type: "message.part.updated", properties: { part: { sessionID } } },
})

describe("idle-deadline activity feed (event hook)", () => {
  beforeEach(() => {
    registry.resetForTests()
  })

  test("the hook is registered", () => {
    const hooks = ultraopen({ client: stubClient })
    expect(typeof hooks["event"]).toBe("function")
  })

  test("a part update for an engine-owned session touches its activity", () => {
    const hooks = ultraopen({ client: stubClient }),
     onEvent = hooks["event"] as (input: unknown) => void
    registry.register("child-1", "run-1")
    onEvent(partEvent("child-1"))
    expect(registry.lastActivity("child-1")).toBeGreaterThan(0)
  })

  test("the user's own sessions are never touched", () => {
    const hooks = ultraopen({ client: stubClient }),
     onEvent = hooks["event"] as (input: unknown) => void
    onEvent(partEvent("user-session"))
    expect(registry.lastActivity("user-session")).toBe(0)
  })

  test("message.updated events are also recognised", () => {
    const hooks = ultraopen({ client: stubClient }),
     onEvent = hooks["event"] as (input: unknown) => void
    registry.register("child-1", "run-1")
    onEvent({ event: { type: "message.updated", properties: { info: { sessionID: "child-1" } } } })
    expect(registry.lastActivity("child-1")).toBeGreaterThan(0)
  })

  test("an unrelated event type is ignored", () => {
    const hooks = ultraopen({ client: stubClient }),
     onEvent = hooks["event"] as (input: unknown) => void
    registry.register("child-1", "run-1")
    expect(() => onEvent({ event: { type: "session.idle", properties: {} } })).not.toThrow()
    expect(registry.lastActivity("child-1")).toBe(0)
  })

  test("a malformed payload never throws", () => {
    const hooks = ultraopen({ client: stubClient }),
     onEvent = hooks["event"] as (input: unknown) => void
    expect(() => onEvent({})).not.toThrow()
    expect(() => onEvent({ event: { type: "message.part.updated", properties: { part: {} } } })).not.toThrow()
  })
})

/**
 * A client whose child prompt never settles: the launch phase completes, the run
 * itself stays in flight — the state every background-contract test needs.
 */
const hangingClient = {
  config: stubClient.config,
  session: { ...stubClient.session, prompt: () => new Promise(() => {}) },
}

describe("background launch contract", () => {
  const statusToolOf = (hooks: Record<string, unknown>): ToolDef | undefined => {
    const tools = hooks["tool"] as Record<string, ToolDef> | undefined
    return tools?.[STATUS_TOOL]
  }
  const settle = background.settlePromiseOf

  test("registers workflow_status next to workflow, with a read-only shape", () => {
    const hooks = ultraopen({ client: stubClient })
    const status = statusToolOf(hooks)
    expect(status).toBeDefined()
    expect(Object.keys(status?.args ?? {})).toContain("runId")
    expect(Object.keys(status?.args ?? {})).toContain("wait")
    expect(status?.description).toContain("wait")
  })

  test("the launch result names the run and says NOTHING about the outcome", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}await agent('a')\nreturn 'SECRET-VALUE'\n`, background: true },
      { sessionID: "parent" },
    )
    expect(output).toContain("<workflow-launched")
    expect(output).toContain("workflow_status")
    expect(output).not.toContain("<result")
    expect(output).not.toContain("SECRET-VALUE")
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1]
    expect(runId).toBeDefined()
    await settle(runId ?? "")
  })

  test("the manifest is on disk BEFORE the tool call returns", async () => {
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}await agent('a')\nreturn 1\n`, background: true }, { sessionID: "parent" })
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    const manifest = await readManifest(runId, undefined)
    // The launch result names a run id that workflow_status must resolve; a run
    // whose manifest lands late would be unfindable between return and beginRun.
    expect(manifest?.status).toBe("running")
    expect(manifest?.sessionID).toBe("parent")
    expect(manifest?.bootId).toBeDefined()
  })

  test("a second launch from the same session is refused while one is live", async () => {
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const first = await tool.execute({ script: `${META}await agent('a')\nreturn 1\n`, background: true }, { sessionID: "parent" })
    expect(first).toContain("<workflow-launched")
    const second = await tool.execute({ script: `${META}return 2\n`, background: true }, { sessionID: "parent" })
    expect(second).toContain("<workflow-refused>")
    expect(second).toContain("workflow_status")
    // The refused call never created a run directory of its own.
    expect(second.match(/run="(?<runId>[^"]+)"/u)?.[1]).toBeUndefined()
  })

  test("two launches from one session in the same tick: exactly one succeeds", async () => {
    // The refusal check and the registration are order-sensitive; both calls
    // must not be able to pass the check before either registers.
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const [a, b] = await Promise.all([
      tool.execute({ script: `${META}await agent('a')\nreturn 1\n`, background: true }, { sessionID: "parent" }),
      tool.execute({ script: `${META}await agent('b')\nreturn 2\n`, background: true }, { sessionID: "parent" }),
    ])
    const launched = [a, b].filter((output) => output.includes("<workflow-launched"))
    const refused = [a, b].filter((output) => output.includes("<workflow-refused>"))
    expect(launched.length).toBe(1)
    expect(refused.length).toBe(1)
  })

  test("a background run settles after the tool call returned", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}await agent('a')\nreturn 'done'\n`, background: true }, { sessionID: "parent" })
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await settle(runId)
    const manifest = await readManifest(runId, undefined)
    expect(manifest?.status).toBe("completed")
    const entries = await readJournal(runId)
    expect(entries.length).toBe(1)
    expect(entries[0]?.status).toBe("ok")
  })

  test("aborting the tool call's signal does not abort the detached run", async () => {
    // The parent turn being interrupted must not kill the run it just launched:
    // the detached Run deliberately never sees the tool call's abort signal.
    const controller = new AbortController(),
      tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}await agent('a')\nreturn 'ok'\n`, background: true },
      { sessionID: "parent", abort: controller.signal },
    )
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    controller.abort()
    await settle(runId)
    // The run's own end-of-script cleanup aborts children as always; what must
    // NOT happen is a signal-driven abort mid-run killing the agent's prompt.
    const settledManifest = await readManifest(runId, undefined)
    expect(settledManifest?.status).toBe("completed")
  })

  test("resuming a run that is still executing is refused", async () => {
    // Two Run instances on one journal would interleave appends and race the
    // endRun rewrite; the live run must settle (or die) before a resume starts.
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const first = await tool.execute({ script: `${META}await agent('a')\nreturn 1\n`, background: true }, { sessionID: "other" })
    const liveRunId = first.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    const second = await tool.execute(
      { script: `${META}await agent('a')\nreturn 2\n`, background: false, resumeFromRunId: liveRunId },
      { sessionID: "parent" },
    )
    expect(second).toContain("<workflow-refused>")
    expect(second).toContain("still executing")
  })

  test("a parse failure in the background contract does not leave a pending launch behind", async () => {
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}const x: string[] = []\n`, background: true }, { sessionID: "parent" })
    expect(output).toContain("ParseError")
    // The session is free to launch again.
    const second = await tool.execute({ script: `${META}return 1\n`, dryRun: true }, { sessionID: "parent" })
    expect(second).toContain("<result")
  })

  test("a rejected permission ask drops the pending launch", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}return 1\n`, background: true },
      { sessionID: "parent", ask: () => Promise.reject(new Error("user said no")) },
    )
    expect(output).toContain("user said no")
    // The session must be free to launch again after the rejection.
    const second = await tool.execute({ script: `${META}return 1\n`, background: true }, { sessionID: "parent" })
    expect(second).toContain("<workflow-launched")
    await settle(second.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? "")
  })

  test("dryRun always waits for its result even in background mode", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}return 1\n`, dryRun: true, background: true }, { sessionID: "parent" })
    expect(output).toContain("<result")
  })

  test("a blocking launch while a detached run is live is refused too", async () => {
    // One live run per session covers BOTH contracts; only dryRun is exempt
    // (it is free and stubbed, the standard mid-run debugging tool).
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const first = await tool.execute({ script: `${META}await agent('a')\nreturn 1\n`, background: true }, { sessionID: "parent" })
    expect(first).toContain("<workflow-launched")
    const blocking = await tool.execute({ script: `${META}return 2\n`, background: false }, { sessionID: "parent" })
    expect(blocking).toContain("<workflow-refused>")
    // dryRun stays allowed while a run is live: it spawns nothing.
    const dry = await tool.execute({ script: `${META}return 3\n`, dryRun: true }, { sessionID: "parent" })
    expect(dry).toContain("<result")
  })

  test("the blocking contract's description describes blocking", () => {
    // The description is model-training text: under the blocking contract it
    // must not teach a polling rhythm for a result the call already returns.
    const tool = toolOf(ultraopen({ client: stubClient }, { runMode: "blocking" }))
    expect(tool?.description).toContain("BLOCKS until the run completes")
    expect(tool?.description).not.toContain("RETURNS AT ONCE")
    const backgroundTool = toolOf(ultraopen({ client: stubClient }))
    expect(backgroundTool?.description).toContain("RETURNS AT ONCE")
  })

  test("the blocking option restores the pre-async contract", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }, { runMode: "blocking" }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}await agent('a')\nreturn 'blocking-value'\n` }, { sessionID: "parent" })
    expect(output).toContain("<result")
    expect(output).toContain("blocking-value")
  })

  test("the status tool reads the settled run from disk", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}await agent('a')\nreturn 'the-value'\n`, background: true }, { sessionID: "parent" })
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await settle(runId)
    const status = statusToolOf(ultraopen({ client: stubClient }))
    if (!status) {throw new Error("status tool was not registered")}
    const report = await status.execute({ runId }, { sessionID: "parent" })
    expect(report).toContain(`status="completed"`)
    expect(report).toContain("the-value")
    expect(report).toContain("agents total=1 running=0 done=1 failed=0")
  })

  test("an unknown run id is a clear error, not a crash", async () => {
    const status = statusToolOf(ultraopen({ client: stubClient }))
    if (!status) {throw new Error("status tool was not registered")}
    const report = await status.execute({ runId: "wf_missing000" }, { sessionID: "parent" })
    expect(report).toContain("No run found")
    expect(report).not.toContain("throw")
    // A malformed id never reaches a path join.
    const traversal = await status.execute({ runId: "../../etc" }, { sessionID: "parent" })
    expect(traversal).toContain("No run found")
  })

  test("a failed background run persists its failure text for the status tool", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}await agent('a')\nthrow new Error('boom mid-run')\n`, background: true },
      { sessionID: "parent" },
    )
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await settle(runId)
    const status = statusToolOf(ultraopen({ client: stubClient }))
    if (!status) {throw new Error("status tool was not registered")}
    const report = await status.execute({ runId }, { sessionID: "parent" })
    expect(report).toContain(`status="failed"`)
    expect(report).toContain("boom mid-run")
    expect(report).toContain("<failure")
  })

  test("the launch result never leaks the outcome even on failure", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}await agent('a')\nthrow new Error('soon-boom')\n`, background: true },
      { sessionID: "parent" },
    )
    expect(output).toContain("<workflow-launched")
    expect(output).not.toContain("soon-boom")
    await settle(output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? "")
  })

  test("ULTRAOPEN_WORKFLOW_SYNC restores the blocking contract without config", async () => {
    // The kill switch must work with NO options object at all: one env var.
    process.env["ULTRAOPEN_WORKFLOW_SYNC"] = "1"
    try {
      const tool = toolOf(ultraopen({ client: stubClient }))
      if (!tool) {throw new Error("tool was not registered")}
      const output = await tool.execute({ script: `${META}return 'sync-value'\n` }, { sessionID: "parent" })
      expect(output).toContain("<result")
      expect(output).toContain("sync-value")
    } finally {
      delete process.env["ULTRAOPEN_WORKFLOW_SYNC"]
    }
  })

  test("the status report carries the run's log lines", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}log('hello from the run')\nawait agent('a')\nreturn 1\n`, background: true },
      { sessionID: "parent" },
    )
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await settle(runId)
    const status = statusToolOf(ultraopen({ client: stubClient }))
    if (!status) {throw new Error("status tool was not registered")}
    const report = await status.execute({ runId }, { sessionID: "parent" })
    expect(report).toContain("<log>")
    expect(report).toContain("hello from the run")
  })

  test("a malformed resume id is refused before any path join", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}return 1\n`, resumeFromRunId: "../../etc", background: false },
      { sessionID: "parent" },
    )
    expect(output).toContain("not a valid run id")
  })

  test("executeStatus can be driven directly against real run artifacts", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}await agent('a')\nreturn 'probe-value'\n`, background: true },
      { sessionID: "parent" },
    )
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    await settle(runId)
    const report = await executeStatus({ runId }, { bootId: "other-boot" })
    expect(report.status).toBe("completed")
    expect(report.value).toBe("probe-value")
    expect(report.outputTokens).toBe(0)
  })
})

describe("blocking launch registration", () => {
  /**
   * A client whose child prompt settles only when the test releases it, so a
   * blocking run can be observed live and then let settle on demand.
   */
  const gatedClient = () => {
    let arm: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {arm = resolve})
    return {
      client: {
        config: stubClient.config,
        session: { ...stubClient.session, prompt: () => gate.then(() => ({ data: { info: {}, parts: [] } })) },
      },
      // The executor runs synchronously, so the release is armed before this returns.
      release: (): void => {arm?.()},
    }
  }

  test("a blocking launch registers a pending entry, so the resume gate covers it while it executes", async () => {
    const { client, release } = gatedClient(),
      tool = toolOf(ultraopen({ client }))
    if (!tool) {throw new Error("tool was not registered")}
    const asked: { metadata?: { runId?: string } }[] = []
    const blocking = tool.execute(
      { script: `${META}await agent('a')\nreturn 'SETTLED-VALUE'\n`, background: false },
      {
        sessionID: "blocker",
        ask: (request: { metadata?: { runId?: string } }) => { asked.push(request); return Promise.resolve() },
      },
    )
    try {
      await waitFor(() => asked.length > 0, "the permission ask")
      const runId = asked[0]?.metadata?.runId ?? ""
      // The gate entry exists before the manifest does; the resume refusal reads
      // the manifest, so wait for the run to go live before attempting it.
      await waitFor(async () => {
        const manifest = await readManifest(runId, undefined)
        return manifest?.status === "running"
      }, "the manifest")
      expect(background.activeRunForSession("blocker")?.runId).toBe(runId)
      expect(background.isLive(runId)).toBe(true)
      const second = await tool.execute(
        { script: `${META}await agent('a')\nreturn 2\n`, resumeFromRunId: runId, background: false },
        { sessionID: "parent" },
      )
      expect(second).toContain("<workflow-refused>")
      expect(second).toContain("still executing")
      // The refused resume attempt drops its own entry, never the live run's.
      expect(background.activeRunForSession("parent")).toBeUndefined()
      expect(background.activeRunForSession("blocker")?.runId).toBe(runId)
    } finally {
      release()
      await blocking
    }
    // A settled blocking launch leaves no stale entry for the next launch to trip on.
    expect(background.activeRunForSession("blocker")).toBeUndefined()
    const settledRunId = asked[0]?.metadata?.runId ?? ""
    const resumed = await tool.execute(
      { script: `${META}await agent('a')\nreturn 2\n`, resumeFromRunId: settledRunId, background: false },
      { sessionID: "parent" },
    )
    expect(resumed).toContain("<result")
  })

  test("a failed blocking run drops its entry when it settles", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}await agent('a')\nthrow new Error('boom mid-run')\n`, background: false },
      { sessionID: "parent" },
    )
    expect(output).toContain("boom mid-run")
    // The run failed, but it settled: the manifest is closed and the gate is open.
    const runId = output.match(/id="(?<runId>[^"]+)"/u)?.[1] ?? ""
    const manifest = await readManifest(runId, undefined)
    expect(manifest?.status).toBe("failed")
    expect(background.activeRunForSession("parent")).toBeUndefined()
  })

  test("dryRun stays exempt from registration as well as the gate", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    let registeredAtAsk: boolean | undefined
    const output = await tool.execute(
      { script: `${META}return 1\n`, dryRun: true },
      {
        sessionID: "parent",
        ask: () => {
          // Read mid-launch, at the ask: a dryRun must never hold the session's gate.
          registeredAtAsk = background.activeRunForSession("parent") !== undefined
          return Promise.resolve()
        },
      },
    )
    expect(output).toContain("<result")
    expect(registeredAtAsk).toBe(false)
    expect(background.activeRunForSession("parent")).toBeUndefined()
  })

  test("a rejected permission ask drops the blocking launch's entry", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}return 1\n`, background: false },
      { sessionID: "parent", ask: () => Promise.reject(new Error("user said no")) },
    )
    expect(output).toContain("user said no")
    expect(background.activeRunForSession("parent")).toBeUndefined()
    // The session must be free to launch again after the rejection.
    const second = await tool.execute({ script: `${META}return 1\n`, dryRun: true }, { sessionID: "parent" })
    expect(second).toContain("<result")
  })

  test("a malformed resume id on the blocking contract frees the session", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}return 1\n`, resumeFromRunId: "../../etc", background: false },
      { sessionID: "parent" },
    )
    expect(output).toContain("not a valid run id")
    expect(background.activeRunForSession("parent")).toBeUndefined()
    const second = await tool.execute({ script: `${META}return 1\n`, background: false }, { sessionID: "parent" })
    expect(second).toContain("<result")
  })
})

describe("background launch contract — unwritable run directory", () => {
  let savedXDG: string | undefined

  beforeEach(() => {
    registry.resetForTests()
    background.resetForTests()
    mode.resetForTests()
    savedXDG = process.env["XDG_DATA_HOME"]
    // mkdir under /dev/null can never succeed, so beginRun cannot open the run
    // directory — the launch must refuse instead of starting an unobservable run.
    process.env["XDG_DATA_HOME"] = "/dev/null/nope"
  })

  afterEach(() => {
    if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
    else {process.env["XDG_DATA_HOME"] = savedXDG}
  })

  test("a beginRun failure aborts the launch instead of starting an unreportable run", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute({ script: `${META}return 1\n`, background: true }, { sessionID: "parent" })
    expect(output).toContain("could not be started")
    expect(output).not.toContain("<workflow-launched")
    // The launch-gating entry is dropped: the session can launch again.
    if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
    else {process.env["XDG_DATA_HOME"] = savedXDG}
    const second = await tool.execute({ script: `${META}return 1\n`, dryRun: true }, { sessionID: "parent" })
    expect(second).toContain("<result")
  })
})

describe("saved workflows (context.named)", () => {
  let configHome: string

  beforeEach(() => {
    registry.resetForTests()
    background.resetForTests()
    mode.resetForTests()
  })

  test("a saved workflow in the config directory runs by name", async () => {
    const { mkdtemp: mkTemp, mkdir, rm: fsRm, writeFile } = await import("node:fs/promises"),
      { tmpdir: osTmpdir } = await import("node:os"),
      { join: cfgJoin } = await import("node:path")
    configHome = await mkTemp(cfgJoin(osTmpdir(), "ultraopen-saved-"))
    const saved = process.env["OPENCODE_CONFIG_DIR"]
    process.env["OPENCODE_CONFIG_DIR"] = configHome
    try {
      const dir = cfgJoin(configHome, "ultraopen", "workflows")
      await mkdir(dir, { recursive: true })
      await writeFile(
        cfgJoin(dir, "deploy-check.js"),
        "export const meta = { name: 'deploy-check', description: 'Deploy gate' }\nreturn 'saved-value'\n",
      )
      const tool = toolOf(ultraopen({ client: stubClient }))
      if (!tool) {throw new Error("tool was not registered")}
      const output = await tool.execute(
        { script: `${META}return await workflow('deploy-check')\n`, background: false },
        { sessionID: "parent" },
      )
      expect(output).toContain("saved-value")
    } finally {
      if (saved === undefined) {delete process.env["OPENCODE_CONFIG_DIR"]}
      else {process.env["OPENCODE_CONFIG_DIR"] = saved}
      await fsRm(configHome, { recursive: true, force: true })
    }
  })

  test("a broken saved file is skipped with a note and never breaks the call", async () => {
    const { mkdtemp: mkTemp, mkdir, rm: fsRm, writeFile } = await import("node:fs/promises"),
      { tmpdir: osTmpdir } = await import("node:os"),
      { join: cfgJoin } = await import("node:path")
    configHome = await mkTemp(cfgJoin(osTmpdir(), "ultraopen-saved-"))
    const saved = process.env["OPENCODE_CONFIG_DIR"]
    process.env["OPENCODE_CONFIG_DIR"] = configHome
    try {
      const dir = cfgJoin(configHome, "ultraopen", "workflows")
      await mkdir(dir, { recursive: true })
      await writeFile(cfgJoin(dir, "broken.js"), "const x: string[] = []\n")
      const tool = toolOf(ultraopen({ client: stubClient }))
      if (!tool) {throw new Error("tool was not registered")}
      const output = await tool.execute({ script: `${META}return 1\n`, dryRun: true }, { sessionID: "parent" })
      expect(output).toContain("<result")
      expect(output).toContain("<scan-notes>")
      expect(output).toContain("broken.js")
    } finally {
      if (saved === undefined) {delete process.env["OPENCODE_CONFIG_DIR"]}
      else {process.env["OPENCODE_CONFIG_DIR"] = saved}
      await fsRm(configHome, { recursive: true, force: true })
    }
  })

  test("one /workflow-<name> command per saved workflow, template keeping $ARGUMENTS", async () => {
    const { mkdtemp: mkTemp, mkdir, rm: fsRm, writeFile } = await import("node:fs/promises"),
      { tmpdir: osTmpdir } = await import("node:os"),
      { join: cfgJoin } = await import("node:path")
    configHome = await mkTemp(cfgJoin(osTmpdir(), "ultraopen-cmds-"))
    const saved = process.env["OPENCODE_CONFIG_DIR"]
    process.env["OPENCODE_CONFIG_DIR"] = configHome
    try {
      const dir = cfgJoin(configHome, "ultraopen", "workflows")
      await mkdir(dir, { recursive: true })
      await writeFile(
        cfgJoin(dir, "deploy-check.js"),
        "export const meta = { name: 'deploy-check', description: 'Deploy gate' }\nreturn 1\n",
      )
      const config: MutableConfig = {}
      ;(ultraopen({ client: stubClient })["config"] as (c: MutableConfig) => void)(config)
      const commands = config.command ?? {}
      const installed = commands["workflow-deploy-check"] as { description?: string; template?: string } | undefined
      expect(installed?.description).toBe("Deploy gate")
      expect(installed?.template).toContain("$ARGUMENTS")
      expect(installed?.template?.length ?? 0).toBeGreaterThan(0)
      // A /workflow-resume command exists out of the box.
      expect((commands["workflow-resume"] as { template?: string } | undefined)?.template).toContain("$ARGUMENTS")
      expect((commands["workflow-resume"] as { template?: string } | undefined)?.template).toContain("resumeFromRunId")
    } finally {
      if (saved === undefined) {delete process.env["OPENCODE_CONFIG_DIR"]}
      else {process.env["OPENCODE_CONFIG_DIR"] = saved}
      await fsRm(configHome, { recursive: true, force: true })
    }
  })

  test("a name with a path separator cannot become a command id", async () => {
    // Guard-rail check on the command installer itself: hostile file names
    // (a readdir only yields real files, but the contract is explicit).
    const config: MutableConfig = {}
    const { installConfig } = await import("../src/server/ultracode/config.js")
    installConfig(config, { workflowCommands: [{ name: "../evil", description: undefined }] })
    expect(config.command?.["workflow-../evil"]).toBeUndefined()
  })
})

describe("safety rails — budget, size advice, script before ask", () => {
  test("budgetTokens reaches the run's budget ceiling", async () => {
    // The budget global is what makes a guarded loop terminate; an option that
    // never reached the engine would be documentation, not a ceiling.
    const tool = toolOf(ultraopen({ client: stubClient }, { budgetTokens: 50 }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}return { total: budget.total, remaining: budget.remaining() }\n`, dryRun: true, background: false },
      { sessionID: "parent" },
    )
    expect(output).toContain('"total": 50')
  })

  test("no budgetTokens means an uncapped budget", async () => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const output = await tool.execute(
      { script: `${META}return { capped: budget.total !== null }\n`, dryRun: true, background: false },
      { sessionID: "parent" },
    )
    expect(output).toContain('"capped": false')
  })

  test("sizeGuideline appends the advice to the tool description", () => {
    const withAdvice = toolOf(ultraopen({ client: stubClient }, { sizeGuideline: "keep runs under 8 agents" }))
    expect(withAdvice?.description).toContain("Size guidance for this project")
    expect(withAdvice?.description).toContain("keep runs under 8 agents")
    // Unset means the line is absent entirely.
    const without = toolOf(ultraopen({ client: stubClient }))
    expect(without?.description).not.toContain("Size guidance for this project")
  })

  test("the script lands in the run directory before the ask resolves", async () => {
    // The user can open the real file while the prompt is on screen.
    const tool = toolOf(ultraopen({ client: hangingClient }))
    if (!tool) {throw new Error("tool was not registered")}
    const asked: unknown[] = []
    const output = await tool.execute(
      { script: `${META}await agent('a')\nreturn 1\n`, background: true },
      {
        sessionID: "parent",
        ask: (request: unknown) => {
          asked.push(request)
          return Promise.resolve()
        },
      },
    )
    const runId = output.match(/run="(?<runId>[^"]+)"/u)?.[1] ?? ""
    expect(asked.length).toBe(1)
    // The script must already be readable when the ask resolves: read it now.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(process.env["XDG_DATA_HOME"] ?? "", "opencode", "tool-output", "ultraopen", runId, "script.js"), "utf8"),
    )
    expect(source).toContain("await agent('a')")
    // The detached task never settles here (the client hangs); the launch-gating
    // state is reset by the suite's beforeEach, not by the run settling.
  })
})
