import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { execute } from "../src/server/tool/workflow.js"
import { registry } from "../src/server/singleton.js"
import type { JournalEntry } from "../src/server/resume/journal.js"
import type { OpencodeClient, PromptBody } from "../src/server/types.js"
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


const META = "export const meta = { name: 'r', description: 'resume tests' }\n"

/**
 * A client that answers with the prompt text, and records how many LIVE calls happened.
 *
 * Latency is scriptable per prompt so a pipeline's stage-1 calls can be made to finish out of
 * order — which is the whole point of these tests.
 */
function makeClient(latency: (prompt: string) => number = () => 0) {
  const livePrompts: string[] = [],
   client = {
    session: {
      create: () => Promise.resolve({ data: { id: `child-${livePrompts.length}` } }),
      get: () => Promise.resolve({ data: { id: "c" } }),
      delete: () => Promise.resolve({}),
      abort: () => Promise.resolve({}),
      prompt: (options: { path: { id: string }; body: PromptBody }) => {
        const text = options.body.parts[0]?.text ?? ""
        livePrompts.push(text)
        // Honour `format`: a schema'd call must come back with `structured`, or the retry ladder
        // fires three times and obscures what the resume logic actually did.
        const structured = options.body.format ? { echoed: text } : undefined
        return new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                data: {
                  info: { tokens: { output: 2 }, ...(structured ? { structured } : {}) },
                  parts: [{ type: "text", text: `R:${text}` }],
                },
              }),
            latency(text),
          )
        })
      },
    },
  } as unknown as OpencodeClient
  return { client, livePrompts }
}

const run = async (
  script: string,
  client: OpencodeClient,
  previous?: readonly JournalEntry[],
  extra?: { onJournal?: (entry: JournalEntry) => void },
): Promise<{ value: unknown; entries: JournalEntry[] }> => {
  const result = await execute(
    { script, ...(previous ? { resumeFromRunId: "wf_prev0000" } : {}) },
    {
      client,
      sessionID: "parent",
      runId: "wf_test0000",
      ...(previous ? { previousEntries: previous, resumedFrom: "wf_prev0000" } : {}),
      ...(extra?.onJournal ? { onJournal: extra.onJournal } : {}),
    },
  )
  return { value: result.value, entries: result.journal }
}

beforeEach(() => {
  registry.resetForTests()
})

describe("flat scripts", () => {
  const script = `${META}
const a = await agent('one')
const b = await agent('two')
const c = await agent('three')
return [a, b, c]
`

  test("a second run with an unchanged script replays everything and makes ZERO live calls", async () => {
    const first = makeClient(),
     before = await run(script, first.client)
    expect(first.livePrompts.length).toBe(3)

    const flushed: JournalEntry[] = []
    const second = makeClient(),
     after = await run(script, second.client, before.entries, { onJournal: (entry) => flushed.push(entry) })
    expect(second.livePrompts).toEqual([])
    expect(after.value).toEqual(before.value)
    // Replayed entries reach the incremental flush like live ones, or a crash-resume and a
    // clean-resume would write different journals.
    expect(flushed.length).toBe(3)
    expect(flushed.every((entry) => entry.replayed === true)).toBe(true)
  })

  test("editing the SECOND call replays the first and runs the rest live", async () => {
    // The chain is what makes this cascade: call three's key depends on call two's, so an edit
    // to two invalidates three even though three's own text is unchanged.
    const first = makeClient(),
     before = await run(script, first.client),

     edited = script.replace("agent('two')", "agent('two-EDITED')"),
     second = makeClient()
    await run(edited, second.client, before.entries)

    expect(second.livePrompts).toEqual(["two-EDITED", "three"])
  })

  test("a recorded FAILURE is never replayed", async () => {
    // Replaying a failure would make a resume look like it covered everything when it recovered
    // nothing — the exact situation the journal exists to expose.
    const failed: JournalEntry[] = [
      { type: "result", key: "anything", scopePath: "root", ordinal: 0, label: "x", status: "null", outputTokens: 0 },
    ],
     client = makeClient()
    await run(`${META}return await agent('one')\n`, client.client, failed)
    expect(client.livePrompts).toEqual(["one"])
  })

  test("a label-only edit still replays — renaming must be free", async () => {
    const first = makeClient(),
     before = await run(`${META}return await agent('one', {label: 'old'})\n`, first.client),

     second = makeClient()
    await run(`${META}return await agent('one', {label: 'new'})\n`, second.client, before.entries)
    expect(second.livePrompts).toEqual([])
  })

  test("a schema edit invalidates, even with an identical prompt", async () => {
    const first = makeClient(),
     before = await run(`${META}return await agent('one', {schema: {type:'object'}})\n`, first.client),

    // Both schemas accept the fake's object reply, so any live call here is the resume decision
    // rather than the structured-output retry ladder.
     second = makeClient()
    await run(
      `${META}return await agent('one', {schema: {type:'object', required: []}})\n`,
      second.client,
      before.entries,
    )
    expect(second.livePrompts).toEqual(["one"])
  })
})

// Stage-1 calls finish in a deliberately scrambled order, so a global counter would assign
// different keys between runs and the chain would diverge at the first reordered call.
function skewed(prompt: string): number {
  if (prompt.startsWith("s1-a")) {
    return 40
  }
  if (prompt.startsWith("s1-b")) {
    return 5
  }
  return 0
}

describe("pipeline — the shape a global sequence would break", () => {
  const script = `${META}
const out = await pipeline(
  ['a', 'b', 'c'],
  (item) => agent('s1-' + item),
  (prev, item) => agent('s2-' + item),
)
return out
`

  test("resuming an unchanged 2-stage pipeline over 3 items makes ZERO live calls", async () => {
    const first = makeClient(skewed),
     before = await run(script, first.client)
    expect(first.livePrompts.length).toBe(6)

    const second = makeClient(skewed),
     after = await run(script, second.client, before.entries)
    expect(second.livePrompts).toEqual([])
    expect(after.value).toEqual(before.value)
  })

  test("each item gets its own scope, so an edit to one item's stage does not invalidate siblings", async () => {
    const first = makeClient(skewed),
     before = await run(script, first.client),

    // Change what item 'b' asks in stage 2 only.
     edited = script.replace("agent('s2-' + item)", "agent(item === 'b' ? 's2-b-EDITED' : 's2-' + item)"),
     second = makeClient(skewed)
    await run(edited, second.client, before.entries)

    // Only b's stage 2 is new. a and c replay entirely; b's stage 1 replays too.
    expect(second.livePrompts).toEqual(["s2-b-EDITED"])
  })

  test("stage order within an item still cascades", async () => {
    const first = makeClient(skewed),
     before = await run(script, first.client),

     edited = script.replace("agent('s1-' + item)", "agent('s1X-' + item)"),
     second = makeClient(skewed)
    await run(edited, second.client, before.entries)

    // Every stage 1 changed, and each item's stage 2 follows it in the same scope.
    expect(second.livePrompts.length).toBe(6)
  })
})

describe("parallel — thunks past the cap start in completion order", () => {
  const script = `${META}
const out = await parallel([
  () => agent('p0'),
  () => agent('p1'),
  () => agent('p2'),
  () => agent('p3'),
])
return out
`

  test("resuming an unchanged parallel makes ZERO live calls even with a small cap", async () => {
    registry.configureConcurrency(2)
    const first = makeClient((p) => (p === "p0" ? 30 : 1)),
     before = await run(script, first.client)
    expect(first.livePrompts.length).toBe(4)

    const second = makeClient((p) => (p === "p0" ? 30 : 1)),
     after = await run(script, second.client, before.entries)
    expect(second.livePrompts).toEqual([])
    expect(after.value).toEqual(before.value)
  })

  test("editing one thunk leaves the others replayable", async () => {
    registry.configureConcurrency(2)
    const first = makeClient(),
     before = await run(script, first.client),

     second = makeClient()
    await run(script.replace("agent('p2')", "agent('p2-EDITED')"), second.client, before.entries)
    expect(second.livePrompts).toEqual(["p2-EDITED"])
  })
})

describe("journal records", () => {
  test("a replayed entry is marked, so a replayed empty is distinguishable from a fresh one", async () => {
    const first = makeClient(),
     before = await run(`${META}return await agent('one')\n`, first.client)
    expect(before.entries[0]?.replayed).toBeUndefined()

    const second = makeClient(),
     after = await run(`${META}return await agent('one')\n`, second.client, before.entries)
    expect(after.entries[0]?.replayed).toBe(true)
    expect(after.entries[0]?.sourceRunId).toBe("wf_prev0000")
  })

  test("entries copy the VALUE rather than pointing at a child session", async () => {
    // Deleting a parent session recursively deletes its children, and a schema'd child cannot be
    // re-read at all — so a pointer-based journal would lose exactly what resume needs.
    const client = makeClient(),
     result = await run(`${META}return await agent('one')\n`, client.client)
    expect(result.entries[0]?.value).toBe("R:one")
  })

  test("scope paths are recorded for debugging", async () => {
    const client = makeClient(),
     result = await run(`${META}await parallel([() => agent('x')])\nreturn 1\n`, client.client)
    expect(result.entries[0]?.scopePath).toBe("root/P0.0")
  })
})
