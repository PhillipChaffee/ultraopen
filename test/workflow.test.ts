import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { execute, renderFailure } from "../src/server/tool/workflow.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"
import { registry } from "../src/server/singleton.js"
import type { OpencodeClient } from "../src/server/types.js"
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


const META = "export const meta = { name: 'demo', description: 'a demo workflow' }\n",

 client = {
  session: {
    create: () => Promise.resolve({ data: { id: "child" } }),
    get: () => Promise.resolve({ data: { id: "child" } }),
    delete: () => Promise.resolve({}),
    abort: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ data: { info: {}, parts: [] } }),
  },
} as unknown as OpencodeClient,

 base = { client, sessionID: "parent", runId: "wf_test" }

beforeEach(() => {
  registry.resetForTests()
})

describe("source resolution", () => {
  test("scriptPath is read through the injected reader", async () => {
    const reads: string[] = [],
     result = await execute(
      { scriptPath: "/runs/demo.js", dryRun: true },
      {
        ...base,
        readScript: (path: string) => {
          reads.push(path)
          return Promise.resolve(`${META}return 'from disk'\n`)
        },
      },
    )
    expect(reads).toEqual(["/runs/demo.js"])
    expect(result.value).toBe("from disk")
  })

  test("scriptPath takes precedence over an inline script", async () => {
    const result = await execute(
      { scriptPath: "/runs/demo.js", script: `${META}return 'inline'\n`, dryRun: true },
      { ...base, readScript: () => Promise.resolve(`${META}return 'from disk'\n`) },
    )
    expect(result.value).toBe("from disk")
  })

  test("scriptPath without a configured reader fails with a clear message", async () => {
    // The engine stays filesystem-free by construction, so the reader is injected. Reaching this
    // branch means the host wired the tool up incompletely — say so rather than throwing a
    // confusing undefined-is-not-a-function.
    await expect(execute({ scriptPath: "/runs/demo.js" }, base)).rejects.toThrow(/no script reader configured/u)
  })

  test("no script at all is reported clearly", async () => {
    await expect(execute({}, base)).rejects.toThrow(/needs a `script`/u)
  })
})

describe("nested workflow()", () => {
  test("an unknown saved workflow THROWS rather than returning null", async () => {
    // The spec is explicit that nested workflow() failures are exceptions, unlike agent() which
    // returns null. A script's try/catch around it would be dead code otherwise.
    const script = `${META}return workflow('other')\n`
    await expect(execute({ script, dryRun: true }, base)).rejects.toThrow(/No saved workflow named "other"/u)
  })

  test("a script CAN catch it WITHOUT awaiting, which is what the spec promises", async () => {
    // Validation is synchronous for exactly this reason: an async function would turn it into a
    // rejected promise that an un-awaited try/catch silently misses.
    const script = `${META}try { workflow('other') } catch (e) { return 'caught' }\nreturn 'not caught'\n`
    const result = await execute({ script, dryRun: true }, base)
    expect(result.value).toBe("caught")
  })

  test("runs a saved workflow by name and prefixes its narration", async () => {
    const named = { helper: `export const meta = { name: 'helper', description: 'h' }\nlog('inner')\nreturn 42\n` },
     script = `${META}return await workflow('helper')\n`,
     result = await execute({ script, dryRun: true }, { ...base, named })
    expect(result.value).toBe(42)
    expect(result.logs.some((line) => line.startsWith("▸ helper:"))).toBe(true)
  })

  test("accepts an inline { script } reference", async () => {
    const script = `${META}return await workflow({ script: "export const meta = { name: 'x', description: 'y' }\\nreturn 7\\n" })\n`
    const result = await execute({ script, dryRun: true }, base)
    expect(result.value).toBe(7)
  })

  test("nesting is ONE level only", async () => {
    // Unbounded depth would make the agent count unbounded with it.
    const inner = `export const meta = { name: 'inner', description: 'i' }\nreturn await workflow('deeper')\n`,
     script = `${META}return await workflow({ script: ${JSON.stringify(inner)} })\n`
    await expect(execute({ script, dryRun: true }, base)).rejects.toThrow(/one level only/u)
  })

  test("rejects a reference that is neither a name nor a script", async () => {
    const script = `${META}return workflow(42)\n`
    await expect(execute({ script, dryRun: true }, base)).rejects.toThrow(/saved workflow name or \{ script \}/u)
  })
})

describe("budget", () => {
  test("total is null when no target was set, which every documented loop guards on", async () => {
    const script = `${META}return { total: budget.total, remaining: budget.remaining() }\n`
    const outcome = await execute({ script, dryRun: true }, base)
    const result = outcome.value as Record<string, unknown>
    expect(result["total"]).toBeNull()
    expect(result["remaining"]).toBe(Number.POSITIVE_INFINITY)
  })

  test("spent() reports real output tokens", async () => {
    const script = `${META}return budget.spent()\n`
    const result = await execute({ script, dryRun: true }, base)
    expect(result.value).toBe(0)
  })
})

describe("args", () => {
  test("args reaches the script verbatim", async () => {
    const script = `${META}return args.items.map(x => x * 2)\n`,
     result = await execute({ script, args: { items: [1, 2, 3] }, dryRun: true }, base)
    expect(result.value).toEqual([2, 4, 6])
  })

  test("args is undefined when not supplied", async () => {
    const script = `${META}return typeof args\n`
    const result = await execute({ script, dryRun: true }, base)
    expect(result.value).toBe("undefined")
  })
})

describe("renderFailure", () => {
  test("renders a WorkflowScriptError diagnostic with a caret when source is supplied", () => {
    const error = new WorkflowScriptError({
      kind: "MetaError",
      message: "bad meta",
      location: { line: 2, column: 4 },
    }),
     out = renderFailure(error, "line one\nline two\n")
    expect(out).toContain("MetaError: bad meta")
    expect(out).toContain("^")
  })

  test("falls back to the message for an ordinary Error", () => {
    expect(renderFailure(new Error("plain failure"))).toBe("plain failure")
  })

  test("stringifies a non-Error throw", () => {
    expect(renderFailure("just a string")).toBe("just a string")
  })
})

describe("cleanup", () => {
  test("child sessions are released even when the script throws", async () => {
    // Children are never cascaded to by the host, so a failed run would otherwise leave subagents
    // running and billing after the parent turn ends.
    const script = `${META}await agent('one')\nthrow new Error('script blew up')\n`
    await expect(execute({ script }, base)).rejects.toThrow("script blew up")
    expect(registry.sessionsOf("wf_test")).toEqual([])
  })
})
