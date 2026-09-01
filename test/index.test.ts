import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { ultraopen } from "../src/server/index.js"
import { registry } from "../src/server/singleton.js"
import { WORKFLOW_TOOL } from "../src/server/bridge/permission.js"
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
let dataHome: string
let savedDataHome: string | undefined

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "ultraopen-testdata-"))
  savedDataHome = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
})

afterAll(async () => {
  if (savedDataHome === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = savedDataHome
  await rm(dataHome, { recursive: true, force: true })
})


type ToolDef = {
  description: string
  args: Record<string, unknown>
  execute: (args: Record<string, unknown>, context: Record<string, unknown>) => Promise<string>
}

const META = "export const meta = { name: 'demo', description: 'a demo workflow' }\n"

/** A client that never actually spawns — index tests exercise wiring, not the bridge. */
const stubClient = {
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
}

const toolOf = (hooks: Record<string, unknown>): ToolDef | undefined => {
  const tools = hooks["tool"] as Record<string, ToolDef> | undefined
  return tools?.[WORKFLOW_TOOL]
}

let savedEnv: string | undefined

beforeEach(() => {
  registry.resetForTests()
  mode.resetForTests()
  savedEnv = process.env["ULTRAOPEN_ACTIVE"]
  delete process.env["ULTRAOPEN_ACTIVE"]
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env["ULTRAOPEN_ACTIVE"]
  else process.env["ULTRAOPEN_ACTIVE"] = savedEnv
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
    const hooks = ultraopen({ client: stubClient })
    const hook = hooks["shell.env"] as (i: { sessionID?: string }, o: { env: Record<string, string> }) => void

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
    const hooks = ultraopen({ client: stubClient })
    const config: MutableConfig = {}
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
    const hooks = ultraopen({ client: stubClient })
    const result = (hooks["config"] as (c: MutableConfig) => unknown)({})
    expect(result).toBeUndefined()
  })
})

describe("tool execution", () => {
  const run = async (args: Record<string, unknown>, context: Record<string, unknown> = {}): Promise<string> => {
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) throw new Error("tool was not registered")
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
    const asked: Array<Record<string, unknown>> = []
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
    const asked: Array<Record<string, unknown>> = []
    const script = "export const meta = { name: 'audit', description: 'Audit auth', phases: [{ title: 'Find' }] }\nreturn 1\n"
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
    const asked: unknown[] = []
    const output = await run(
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
    expect(await run({ scriptPath: paths })).toContain("from disk")
  })

  test("a failed run persists its PARTIAL journal so a resume can replay what succeeded", async () => {
    // Without this, endRun on failure wrote an empty journal and destroyed the replayable prefix
    // of agents that had already completed — resume would redo work it already paid for.
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) throw new Error("tool was not registered")
    const script = `${META}await agent('succeeds')\nthrow new Error('script blew up')\n`
    const output = await tool.execute({ script }, { sessionID: "parent" })
    expect(output).toContain("script blew up")

    // Find the run id from the tool's rendered failure — the journal is keyed by run.
    const runId = output.match(/id="([^"]+)"/u)?.[1]
    expect(runId).toBeDefined()
    const entries = await readJournal(runId ?? "")
    expect(entries.length).toBe(1)
    expect(entries[0]?.status).toBe("ok")
    expect((await readManifest(runId ?? "", undefined))?.status).toBe("failed")
  })

  test("an aborted run persists its child sessions in the manifest", async () => {
    // The manifest's child list is what the startup reaper reads; if it were only written at
    // endRun — after the registry was cleared — the reaper would always read [].
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) throw new Error("tool was not registered")
    const script = `${META}await agent('a')\nreturn 'done'\n`
    const output = await tool.execute({ script }, { sessionID: "parent" })
    const runId = output.match(/run="([^"]+)"/u)?.[1]
    expect(runId).toBeDefined()
    expect((await readManifest(runId ?? "", undefined))?.childSessionIDs).toEqual(["child"])
  })

  test("a resume with changed args renders the args-changed note", async () => {
    // A replayed run must never read as a fresh one — this note is the visible marker that
    // nothing was replayed because the inputs changed.
    const tool = toolOf(ultraopen({ client: stubClient }))
    if (!tool) throw new Error("tool was not registered")
    const script = `${META}await agent('a')\nreturn 'ok'\n`

    const first = await tool.execute({ script, args: { topic: "one" } }, { sessionID: "parent" })
    const runId = first.match(/run="([^"]+)"/u)?.[1]
    expect(runId).toBeDefined()

    const second = await tool.execute(
      { script, args: { topic: "two" }, resumeFromRunId: runId },
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
    const failing = { session: { ...stubClient.session, create: () => Promise.resolve({ error: "nope" }) } }
    const tool = toolOf(ultraopen({ client: failing }))
    const output = await tool?.execute(
      { script: `${META}await parallel([() => agent('a'), () => agent('b')])\nreturn 'done'\n` },
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
    const tool = toolOf(ultraopen({ client: catalogClient }))
    const script = `${META}await agent('x', { effort: 'xhigh' })\nreturn 'done'\n`
    const output = await tool?.execute({ script }, { sessionID: "parent" })

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
    }
    const tool = toolOf(ultraopen({ client: failing }))
    const output = await tool?.execute({ script: `${META}return 'fine'\n` }, { sessionID: "parent" })
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
    }
    const tool = toolOf(ultraopen({ client: watched }))
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
    }
    const hooks = ultraopen({ client: hostile })
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
