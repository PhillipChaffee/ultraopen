import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { execute, prepare, projectAgentCount, renderFailure, WorkflowRunError } from "../src/server/tool/workflow.js"
import type { WorkflowArgs } from "../src/server/tool/workflow.js"
import { inspectArgsTransport } from "../src/server/tool/args-transport.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"
import { parse } from "../src/server/script/parse.js"
import { MAX_AGENTS_PER_RUN } from "../src/server/script/limits.js"
import { argsHash } from "../src/server/resume/key.js"
import { registry } from "../src/server/singleton.js"
import type { OpencodeClient } from "../src/server/types.js"
import type { ProgressEvent } from "../src/server/runtime/run.js"
import { existsSync } from "node:fs"
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

/** Every live call spends 600 output tokens and records its prompt, for budget and family tests. */
function liveClient(): { client: OpencodeClient; prompts: string[] } {
  const prompts: string[] = [],
    inner = {
      session: {
        create: () => Promise.resolve({ data: { id: "child" } }),
        get: () => Promise.resolve({ data: { id: "child" } }),
        delete: () => Promise.resolve({}),
        abort: () => Promise.resolve({}),
        prompt: (options: { body: { parts: { text?: string }[] } }) => {
          prompts.push(options.body.parts[0]?.text ?? "")
          return Promise.resolve({ data: { info: { tokens: { output: 600 } }, parts: [{ type: "text", text: "done" }] } })
        },
      },
    } as unknown as OpencodeClient
  return { client: inner, prompts }
}

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

describe("args transport (#78)", () => {
  // Layer 1: narrow hydration at the engine boundary. A stringified JSON object or array is
  // repaired (loudly); a string that looks like JSON but fails to parse is refused; honest
  // scalar strings — including JSON-parseable scalars like "42" — pass through untouched.
  test("prepare hydrates a stringified JSON object without mutating the caller's record", async () => {
    const args: WorkflowArgs = { script: `${META}return args\n`, args: '{"repo":"dot-agents-alignment"}' }
    const prepared = await prepare(args, base)
    expect(args.args).toBe('{"repo":"dot-agents-alignment"}')
    expect(prepared.argsValue).toEqual({ repo: "dot-agents-alignment" })
    expect(prepared.argsHydrated?.raw).toBe('{"repo":"dot-agents-alignment"}')
    expect(prepared.argsHydrated?.kind).toBe("object")
  })

  test("prepare hydrates a stringified JSON array too", async () => {
    const prepared = await prepare({ script: `${META}return args\n`, args: "[1,2]" }, base)
    expect(prepared.argsValue).toEqual([1, 2])
    expect(prepared.argsHydrated?.kind).toBe("array")
  })

  test("an honest scalar string stays untouched", async () => {
    for (const scalar of ["42", "review-targets", '"42"']) {
      const args: WorkflowArgs = { script: `${META}return args\n`, args: scalar }
      const prepared = await prepare(args, base)
      expect(prepared.argsValue).toBe(scalar)
      expect(prepared.argsHydrated).toBeUndefined()
    }
  })

  test("a JSON-looking string that fails to parse is refused before anything runs", async () => {
    const args: WorkflowArgs = { script: `${META}return args\n`, args: '{"repo":' }
    await expect(prepare(args, base)).rejects.toThrow(/looks like JSON but does not parse/u)
    expect(args.args).toBe('{"repo":')
  })

  test("the refuse decision tolerates surrounding whitespace, both ways", () => {
    // JSON.parse accepts padded payloads, so padded-but-parseable hydrates and padded-but-broken
    // refuses — the trimStart() guard is load-bearing for the second half.
    expect(inspectArgsTransport(' {"repo":"r"}').action).toBe("hydrate")
    expect(inspectArgsTransport('\t[1,2]').action).toBe("hydrate")
    expect(inspectArgsTransport(' {"repo":').action).toBe("refuse")
    expect(inspectArgsTransport('{"a":1} ').action).toBe("hydrate")
  })

  test("a payload too deeply nested to hash is refused before anything runs", async () => {
    // JSON.parse is iterative and accepts what argsHash's recursion cannot: a deep-but-parseable
    // payload must refuse at the boundary, not overflow after the permission ask (review finding).
    const deep = `${"[".repeat(100_000)}1${"]".repeat(100_000)}`
    const args: WorkflowArgs = { script: `${META}return args\n`, args: deep }
    await expect(prepare(args, base)).rejects.toThrow(/too deeply nested to hash/u)
    expect(args.args).toBe(deep)
  })

  test("execute's own refusal is an unwrapped WorkflowScriptError that renders with the payload", async () => {
    // Direct engine callers rely on this contract: the refuse branch throws BEFORE the run, so
    // no WorkflowRunError wrapping exists, and renderFailure shows the previewed payload.
    const failure = await execute({ script: `${META}return args\n`, args: '{"repo":' }, base).catch(
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    const rendered = renderFailure(failure, `{"repo":`)
    expect(rendered).toContain("does not parse")
    expect(rendered).toContain("real JSON")
  })

  test("execute hands the hydrated object to the script and logs the repair", async () => {
    const result = await execute(
      { script: `${META}return args.repo\n`, args: '{"diff":"none","repo":"dot-agents-alignment"}', dryRun: true },
      base,
    )
    expect(result.value).toBe("dot-agents-alignment")
    expect(result.logs).toContain("args arrived as a JSON string; hydrated to object")
  })

  test("execute throws at start for a dereferencing script with non-object args — zero agents", async () => {
    const prompts: string[] = [],
     promptClient = {
      session: {
        create: () => Promise.resolve({ data: { id: "child" } }),
        get: () => Promise.resolve({ data: { id: "child" } }),
        delete: () => Promise.resolve({}),
        abort: () => Promise.resolve({}),
        prompt: (options: { body: { parts: { text?: string }[] } }) => {
          prompts.push(options.body.parts[0]?.text ?? "")
          return Promise.resolve({ data: { info: {}, parts: [] } })
        },
      },
    } as unknown as OpencodeClient
    for (const bad of ["review-targets", 42, undefined]) {
      prompts.length = 0
      await expect(execute({ script: `${META}log('probe: ' + args.repo)\nreturn 1\n`, args: bad }, { ...base, client: promptClient })).rejects.toThrow(
        /args arrived as/u,
      )
      expect(prompts).toEqual([])
    }
  })

  test("the start throw names the received type and a preview, with the dereference line", async () => {
    const failure = await execute({ script: `${META}return args.repo\n`, args: "review-targets" }, base).catch(
      (error: unknown) => error,
    )
    // execute wraps run failures in WorkflowRunError; the cause carries the script diagnostic,
    // which the tool layer unwraps for rendering — location included, caret and all.
    expect(failure).toBeInstanceOf(WorkflowRunError)
    const cause = (failure as WorkflowRunError).cause
    expect(cause).toBeInstanceOf(WorkflowScriptError)
    const diagnostic = (cause as WorkflowScriptError).diagnostic
    expect(diagnostic.message).toContain("the string")
    expect(diagnostic.message).toContain("review-targets")
    expect(diagnostic.location).toEqual({ line: 2, column: 7 })
  })

  test("a pass-through script keeps scalar args working end to end", async () => {
    const result = await execute({ script: `${META}return typeof args + ':' + args\n`, args: "42", dryRun: true }, base)
    expect(result.value).toBe("string:42")
    expect(result.logs.some((line) => line.includes("hydrated"))).toBe(false)
  })

  test("the projection degrades when the gate fires, and reads the hydrated args otherwise", async () => {
    // prepare is pure: the projection reads the hydrated value off the prepared workflow, not
    // off the args record.
    const deref = `${META}for (const item of args.items) { await agent('item ' + item) }\n`
    const hydrated = await prepare({ script: deref, args: '{"items":[1,2]}' }, base)
    expect(await projectAgentCount(hydrated, undefined)).toBe(2)
    const scalar = await prepare({ script: deref, args: "42" }, base)
    await expect(projectAgentCount(scalar, undefined)).rejects.toThrow(/args arrived as/u)
  })

  test("hydration happens before hashing, so a hydrated launch and an object-args resume agree", async () => {
    const raw = '{"repo":"dot-agents-alignment"}'
    const prepared = await prepare({ script: `${META}return args\n`, args: raw }, base)
    expect(argsHash(prepared.argsValue)).toBe(argsHash({ repo: "dot-agents-alignment" }))
    expect(argsHash(prepared.argsValue)).not.toBe(argsHash(raw))
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

  test("renders the suggestions of a fed-promises authoring error obtained by real invocation (#145)", async () => {
    // The error must come from a REAL parallel() call fed promises — a hand-constructed
    // WorkflowScriptError would be green on arrival, since renderFailure already renders
    // suggestions for that type. Today this is red: the bare TypeError carries no suggestions.
    const { parallel } = await import("../src/server/runtime/combinators.js")
    const thrown = await parallel([Promise.resolve(1) as unknown as () => unknown]).then(
      () => undefined,
      (error: unknown) => error,
    )
    const out = renderFailure(thrown as Error)
    expect(out).toContain("RuntimeError")
    expect(out).toContain("not promises")
    expect(out).toContain("→")
    expect(out).toContain("() =>")
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

/**
 * A client that records every spawn call so tests can assert NOTHING was sent — the projection's
 * side-effect-free guarantee is that the client is never touched at all.
 */
function recordingClient(): { client: OpencodeClient; spawned: number } {
  let spawned = 0
  const recording = {
    session: {
      create: () => {
        spawned++
        return Promise.resolve({ data: { id: "child" } })
      },
      get: () => Promise.resolve({ data: { id: "child" } }),
      delete: () => Promise.resolve({}),
      abort: () => Promise.resolve({}),
      prompt: () => {
        spawned++
        return Promise.resolve({ data: { info: {}, parts: [] } })
      },
    },
  } as unknown as OpencodeClient
  return { client: recording, get spawned() {return spawned} }
}

describe("projectAgentCount", () => {
  test("counts the full fan-out of parallel and sequential calls", async () => {
    // phase/log are real globals during projection: narration no-ops, called here so the
    // pass exercises the same globals a live run would.
    const script = `${META}phase('probe')\nlog('projecting')\nawait parallel([() => agent('a'), () => agent('b'), () => agent('c')])\nawait agent('d')\nawait agent('e')\n`
    const prepared = await prepare({ script }, base)
    expect(await projectAgentCount(prepared, undefined)).toBe(5)
  })

  test("counts agents inside a nested workflow, by name and inline", async () => {
    // Nested children share the parent's budget and semaphore, so the launch advisory must
    // count them too — a projection that stopped at the parent's own calls would understate
    // exactly the launches worth flagging.
    const named = {
      helper: `export const meta = { name: 'helper', description: 'h' }\nawait agent('h1')\nawait agent('h2')\nreturn 1\n`,
    },
     script = `${META}await parallel([() => agent('p1'), () => agent('p2')])\nawait workflow('helper')\nawait workflow({ script: ${JSON.stringify(`export const meta = { name: 'x', description: 'x' }\nawait agent('x1')\n`)} })\n`,
     prepared = await prepare({ script }, { ...base, named })
    expect(await projectAgentCount(prepared, named)).toBe(5)
  })

  test("reads args like the real run", async () => {
    const script = `${META}for (const item of args.items) { await agent('item ' + item) }\n`,
     prepared = await prepare({ script, args: { items: [1, 2, 3, 4] } }, base)
    expect(await projectAgentCount(prepared, undefined)).toBe(4)
  })

  test("runs the budget UNCAPPED, matching an uncapped run's control flow", async () => {
    // Spend is unknowable for free, so the projection budget reports no ceiling. A script
    // throwing with the values is the only way to observe the global from outside.
    const script = `${META}throw new Error('total=' + budget.total + ' remaining=' + budget.remaining() + ' spent=' + budget.spent())\n`
    const prepared = await prepare({ script }, base)
    await expect(projectAgentCount(prepared, undefined)).rejects.toThrow(
      /total=null remaining=Infinity spent=0/u,
    )
  })

  test("is side-effect free: repeatable, no registry sessions, no files on disk", async () => {
    // The whole launch advisory rests on the projection being free AND inert. It runs twice
    // identically (nothing was consumed), the registry gains no sessions (nothing spawned), and
    // the run directory never appears (nothing persisted).
    const script = `${META}await parallel([() => agent('a'), () => agent('b')])\nawait agent('c')\n`,
     prepared = await prepare({ script }, base)
    expect(await projectAgentCount(prepared, undefined)).toBe(3)
    expect(await projectAgentCount(prepared, undefined)).toBe(3)
    expect(registry.sessionsOf("wf_test")).toEqual([])
    expect(existsSync(join(dataHome, "opencode", "tool-output", "ultraopen", "wf_test"))).toBe(false)
  })

  test("the stub answers match the dry run's shape, so control-flow parity holds", async () => {
    // A script that branches on an agent's RESULT sees the same stub value a dry run would
    // give — the projection and the dry run are the same free preview, from the script's view.
    const script = `${META}const plain = await agent('p')\nconst shaped = await agent('s', { schema: { type: 'object' } })\nthrow new Error(typeof plain + ':' + plain + '|' + JSON.stringify(shaped))\n`
    const prepared = await prepare({ script }, base)
    await expect(projectAgentCount(prepared, undefined)).rejects.toThrow(
      /string:\[dryRun\] p\|\{\}/u,
    )
  })

  test("a script error surfaces so the caller can degrade to no projection", async () => {
    const script = `${META}throw new Error('boom')\n`
    const prepared = await prepare({ script }, base)
    await expect(projectAgentCount(prepared, undefined)).rejects.toThrow("boom")
  })

  test("a determinism trap surfaces the same way the real run would fail", async () => {
    // The static lint catches literal Date.now() at parse time, so this body arrives via a
    // hand-built PreparedWorkflow — the runtime trap (the guarded Date) is what must surface
    // from the projection pass itself.
    const prepared = { source: META, meta: parse(META).meta, body: "Date.now()\n", argsValue: undefined, argsDereference: undefined, argsHydrated: undefined }
    await expect(projectAgentCount(prepared, undefined)).rejects.toThrow(WorkflowScriptError)
  })

  test("an aborted launch stops the projection", async () => {
    const controller = new AbortController()
    controller.abort()
    const script = `${META}await agent('a')\n`
    const prepared = await prepare({ script }, base)
    await expect(projectAgentCount(prepared, undefined, { signal: controller.signal })).rejects.toThrow(
      /interrupted/u,
    )
  })

  test("an unguarded fan-out stops at the lifetime backstop instead of hanging the launch", async () => {
    // The projection cannot spend its way out of a runaway loop, so the cap that bounds a real
    // run bounds the projection too — the advisory reports the backstop itself.
    const script = `${META}while (true) { await agent('x') }\n`
    const prepared = await prepare({ script }, base)
    expect(await projectAgentCount(prepared, undefined)).toBe(MAX_AGENTS_PER_RUN)
  })

  test("nested nesting obeys the same one-level rule the engine enforces", async () => {
    const inner = `export const meta = { name: 'inner', description: 'i' }\nreturn await workflow('deeper')\n`,
     script = `${META}return await workflow({ script: ${JSON.stringify(inner)} })\n`
    const prepared = await prepare({ script }, base)
    await expect(projectAgentCount(prepared, undefined)).rejects.toThrow(/one level only/u)
  })
})

describe("nested workflow() — dry run inheritance", () => {
  test("a nested workflow stays dry inside a dryRun: no spawn, dry narration", async () => {
    // Regression: the nested call used to receive fresh args without dryRun and would execute
    // for real inside a free preview — the one door around the stubbed agent().
    const { client: recording, spawned } = recordingClient(),
     named = {
      inner: `export const meta = { name: 'inner', description: 'i' }\nawait agent('inside')\nreturn 'inner-done'\n`,
     },
     script = `${META}return await workflow('inner')\n`,
     result = await execute({ script, dryRun: true }, { ...base, client: recording, named })
    expect(result.value).toBe("inner-done")
    expect(spawned).toBe(0)
    expect(result.logs.some((line) => line.startsWith("▸ inner:") && line.includes("[dryRun]"))).toBe(true)
  })
})

describe("dry run — the agent contract holds under the stub", () => {
  test("a dry run refuses a non-string agent prompt exactly as a live run does", async () => {
    // The dry contract says it exercises the whole engine; the live agent throws on a
    // non-string prompt, so the stub must too — or a dry pass would vouch for a script that
    // dies at its first agent() call the moment it runs for real (unit C's review-panel
    // launch failed live on exactly this shape after its dry checks were skipped).
    await expect(execute({ script: `${META}await agent(['x'])\n`, dryRun: true }, base))
      .rejects.toThrow(/requires a non-empty prompt string/u)
  })

  test("a dry run refuses an empty prompt exactly as a live run does", async () => {
    await expect(execute({ script: `${META}await agent('  ')\n`, dryRun: true }, base))
      .rejects.toThrow(/requires a non-empty prompt string/u)
  })

  test("a dry run refuses a provably contradictory schema exactly as a live run does", async () => {
    // The stub carries the live agent's whole argument guard: a dry pass may not vouch for a
    // script whose first agent() call would die live on the contradictory-schema TypeError.
    await expect(
      execute(
        { script: `${META}await agent('x', { schema: { type: 'object', additionalProperties: false, required: ['id'], properties: {} } })\n`, dryRun: true },
        base,
      ),
    ).rejects.toThrow(/"id"/u)
    await expect(
      execute(
        { script: `${META}await agent('x', { schema: { type: 'number', minimum: 10, maximum: 5 } })\n`, dryRun: true },
        base,
      ),
    ).rejects.toThrow(/minimum 10 is above maximum 5/u)
  })

  test("a dry run still counts and narrates valid agent calls", async () => {
    // The guard must not dampen the stub's own contract: valid prompts still count toward
    // agentCount and narrate [dryRun] lines.
    const result = await execute({ script: `${META}const a = await agent('one')\nreturn a\n`, dryRun: true }, base)
    expect(result.agentCount).toBe(1)
    expect(result.logs.some((line) => line.includes("[dryRun]"))).toBe(true)
  })
})

describe("budget — end to end", () => {
  test("a run past the ceiling fails cleanly with the partial journal intact", async () => {
    // The budget is a HARD ceiling enforced at agent() entry: the first agent spends past it,
    // the next call throws, and the run fails — but what completed stays complete, so a resume
    // can replay it. The spend client answers with 600 output tokens against a 100-token cap.
    const spendClient = {
      session: {
        create: () => Promise.resolve({ data: { id: "child" } }),
        get: () => Promise.resolve({ data: { id: "child" } }),
        delete: () => Promise.resolve({}),
        abort: () => Promise.resolve({}),
        prompt: () =>
          Promise.resolve({ data: { info: { tokens: { output: 600 } }, parts: [{ type: "text", text: "done" }] } }),
      },
    } as unknown as OpencodeClient
    const script = `${META}await agent('first')\nawait agent('second')\nreturn 'done'\n`
    let caught: unknown
    try {
      await execute({ script }, { ...base, client: spendClient, budgetTotal: 100 })
      expect.unreachable()
    } catch (error) {
      caught = error
    }
    expect((caught as Error).name).toBe("WorkflowRunError")
    const partial = (caught as Error & { partial: { journal: { outputTokens: number }[]; childSessionIDs: string[] } }).partial
    expect(partial.journal).toHaveLength(1)
    expect(partial.journal[0]?.outputTokens).toBe(600)
    // The child list is captured BEFORE cleanup (crash forensics: the reaper must be able to
    // abort the session that exists), and cleanup then releases it.
    expect(partial.childSessionIDs).toEqual(["child"])
    expect(registry.sessionsOf("wf_test")).toEqual([])
    expect((caught as Error).message).toContain("100 output-token budget")
  })
})

describe("budget — nested family", () => {
  // Every live call spends 600 output tokens against a 100-token cap, so a single call crosses
  // the ceiling and the next call in the family is refused before it spends anything.
  const helper = `export const meta = { name: 'helper', description: 'h' }\nawait agent('h1')\n`

  test("a nested child draws the parent's ceiling instead of a fresh one", async () => {
    // The option docstring and README both promise sharing: the child's spend must reach the
    // parent's ledger, and both scripts' budget globals must read the same family total.
    const script = `${META}const child = await workflow({ script: ${JSON.stringify(`${helper}return budget.spent()`)} })\nreturn { child, spent: budget.spent(), remaining: budget.remaining() }\n`
    const events: ProgressEvent[] = []
    const result = await execute({ script }, {
      ...base,
      client: liveClient().client,
      budgetTotal: 100,
      onProgress: (event) => {events.push(event)},
    })
    expect(result.value).toEqual({ child: 600, spent: 600, remaining: 0 })
    // The event-fed total progress.json accumulates (family-wide via the shared onProgress)
    // agrees with the family ledger instead of contradicting it.
    const eventFed = events
      .filter((event) => event.type === "agent-end")
      .reduce((total, event) => total + ((event as { outputTokens?: number }).outputTokens ?? 0), 0)
    expect(eventFed).toBe(600)
  })

  test("the family cannot spend (k+1) × total: a child's later call is refused", async () => {
    // The bug this closes: runNested passed only the NUMBER into a fresh child Run, so every
    // nested call re-spent the full ceiling. The child's SECOND call must hit the ceiling, and
    // the refused call must add nothing to the family's spend.
    const overflow = `${helper}await agent('h2')\nreturn 'helper done'\n`
    const script = `${META}try {\n  return await workflow({ script: ${JSON.stringify(overflow)} })\n} catch (e) {\n  const cause = String(e?.cause?.message ?? e?.message)\n  return { refused: cause.includes('100 output-token budget'), spent: budget.spent() }\n}\n`
    const result = await execute({ script }, { ...base, client: liveClient().client, budgetTotal: 100 })
    expect(result.value).toEqual({ refused: true, spent: 600 })
  })

  test("a resumed run's family counts replayed spend against the ceiling", async () => {
    // Replayed entries are paid: on resume the child replays its entry (zero live calls), the
    // family still counts that spend, and the parent's next call is refused on it.
    const named = { helper: `${helper}return 'helper done'\n` },
      script = `${META}await workflow('helper')\nlet blocked\ntry { await agent('p1') } catch (e) { blocked = String(e.message) }\nreturn { blocked, spent: budget.spent() }\n`

    const first = liveClient(),
      before = await execute({ script }, { ...base, client: first.client, budgetTotal: 100, named }),
      firstValue = before.value as { blocked: string; spent: number }
    // The child spent its 600 live; the parent's own call was refused on the family total.
    expect(first.prompts).toEqual(["h1"])
    expect(firstValue.blocked).toContain("100 output-token budget")
    expect(firstValue.spent).toBe(600)

    const second = liveClient(),
      after = await execute(
        { script },
        { ...base, client: second.client, budgetTotal: 100, named, previousEntries: before.journal, resumedFrom: "wf_test" },
      ),
      secondValue = after.value as { blocked: string; spent: number }
    // Nothing re-spent — the replay alone fills the family ledger and still refuses p1.
    expect(second.prompts).toEqual([])
    expect(secondValue.blocked).toContain("100 output-token budget")
    expect(secondValue.spent).toBe(600)
  })
})
