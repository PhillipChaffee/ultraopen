import { beforeEach, describe, expect, test } from "bun:test"
import { execute, renderFailure } from "../src/server/tool/workflow.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"
import { registry } from "../src/server/singleton.js"
import type { OpencodeClient } from "../src/server/types.js"

const META = "export const meta = { name: 'demo', description: 'a demo workflow' }\n"

const client = {
  session: {
    create: () => Promise.resolve({ data: { id: "child" } }),
    get: () => Promise.resolve({ data: { id: "child" } }),
    delete: () => Promise.resolve({}),
    abort: () => Promise.resolve({}),
    prompt: () => Promise.resolve({ data: { info: {}, parts: [] } }),
  },
} as unknown as OpencodeClient

const base = { client, sessionID: "parent", runId: "wf_test" }

beforeEach(() => {
  registry.resetForTests()
})

describe("source resolution", () => {
  test("scriptPath is read through the injected reader", async () => {
    const reads: string[] = []
    const result = await execute(
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
  test("calling workflow() from a script THROWS rather than returning null", async () => {
    // The spec is explicit that nested workflow() failures are exceptions, unlike agent() which
    // returns null. A script's try/catch around it would be dead code otherwise.
    const script = `${META}return workflow('other')\n`
    await expect(execute({ script, dryRun: true }, base)).rejects.toThrow(/Nested workflow\(\) is not available/u)
  })

  test("a script CAN catch it, which is what the spec promises", async () => {
    const script = `${META}try { workflow('other') } catch (e) { return 'caught' }\nreturn 'not caught'\n`
    const result = await execute({ script, dryRun: true }, base)
    expect(result.value).toBe("caught")
  })
})

describe("budget", () => {
  test("total is null when no target was set, which every documented loop guards on", async () => {
    const script = `${META}return { total: budget.total, remaining: budget.remaining() }\n`
    const result = (await execute({ script, dryRun: true }, base)).value as Record<string, unknown>
    expect(result["total"]).toBeNull()
    expect(result["remaining"]).toBe(Number.POSITIVE_INFINITY)
  })

  test("spent() reports real output tokens", async () => {
    const script = `${META}return budget.spent()\n`
    expect((await execute({ script, dryRun: true }, base)).value).toBe(0)
  })
})

describe("args", () => {
  test("args reaches the script verbatim", async () => {
    const script = `${META}return args.items.map(x => x * 2)\n`
    const result = await execute({ script, args: { items: [1, 2, 3] }, dryRun: true }, base)
    expect(result.value).toEqual([2, 4, 6])
  })

  test("args is undefined when not supplied", async () => {
    const script = `${META}return typeof args\n`
    expect((await execute({ script, dryRun: true }, base)).value).toBe("undefined")
  })
})

describe("renderFailure", () => {
  test("renders a WorkflowScriptError diagnostic with a caret when source is supplied", () => {
    const error = new WorkflowScriptError({
      kind: "MetaError",
      message: "bad meta",
      location: { line: 2, column: 4 },
    })
    const out = renderFailure(error, "line one\nline two\n")
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
