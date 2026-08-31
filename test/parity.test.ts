import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execute } from "../src/server/tool/workflow.js"
import { registry } from "../src/server/singleton.js"
import type { OpencodeClient, PromptBody } from "../src/server/types.js"

/**
 * The acceptance gate: the spec's own worked examples, run UNCHANGED.
 *
 * These are the scripts a model trained on Claude Code will actually write. If one of them needs
 * editing to run here, the port has diverged in a way that matters more than any unit test.
 */

let dataHome: string
let saved: string | undefined

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "ultraopen-parity-"))
  saved = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = dataHome
})

afterAll(async () => {
  if (saved === undefined) delete process.env["XDG_DATA_HOME"]
  else process.env["XDG_DATA_HOME"] = saved
  await rm(dataHome, { recursive: true, force: true })
})

beforeEach(() => {
  registry.resetForTests()
})

/** Answers every agent with a schema-shaped object when asked, else echoes the prompt. */
function makeClient() {
  let n = 0
  return {
    session: {
      create: () => Promise.resolve({ data: { id: `c${n++}` } }),
      get: () => Promise.resolve({ data: { id: "c" } }),
      delete: () => Promise.resolve({}),
      abort: () => Promise.resolve({}),
      prompt: (options: { path: { id: string }; body: PromptBody }) => {
        const text = options.body.parts[0]?.text ?? ""
        const structured = options.body.format
          ? { findings: [{ title: `finding for ${text.slice(0, 12)}` }], isReal: true, bugs: [{ desc: text.slice(0, 8) }] }
          : undefined
        return Promise.resolve({
          data: {
            info: { tokens: { output: 2 }, ...(structured ? { structured } : {}) },
            parts: [{ type: "text", text: `answer:${text.slice(0, 20)}` }],
          },
        })
      },
    },
  } as unknown as OpencodeClient
}

const run = (script: string, args?: unknown) =>
  execute({ script, ...(args === undefined ? {} : { args }) }, { client: makeClient(), sessionID: "p", runId: "wf_parity01" })

describe("spec §2.9 — canonical multi-stage pipeline", () => {
  test("runs unchanged", async () => {
    const FINDINGS = { type: "object", properties: { findings: { type: "array" } } }
    const script = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
const FINDINGS = ${JSON.stringify(FINDINGS)}
const VERDICT = { type: 'object', properties: { isReal: { type: 'boolean' } } }
const DIMENSIONS = [{key: 'bugs', prompt: 'find bugs'}, {key: 'perf', prompt: 'find perf issues'}]
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {label: \`review:\${d.key}\`, phase: 'Review', schema: FINDINGS}),
  review => parallel(review.findings.map(f => () =>
    agent(\`Adversarially verify: \${f.title}\`, {label: \`verify:\${f.title}\`, phase: 'Verify', schema: VERDICT})
      .then(v => ({...f, verdict: v}))
  ))
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)
return { confirmed }
`
    const result = await run(script)
    const value = result.value as { confirmed: unknown[] }
    expect(value.confirmed.length).toBe(2)
    expect(result.agentCount).toBe(4)
  })
})

describe("spec §2.9 — barrier before expensive verification", () => {
  test("runs unchanged", async () => {
    const script = `export const meta = { name: 'dedup', description: 'Dedup before verifying' }
const FINDINGS = { type: 'object', properties: { findings: { type: 'array' } } }
const VERDICT = { type: 'object', properties: { isReal: { type: 'boolean' } } }
const DIMENSIONS = [{prompt: 'a'}, {prompt: 'b'}]
const all = await parallel(DIMENSIONS.map(d => () => agent(d.prompt, {schema: FINDINGS})))
const deduped = all.filter(Boolean).flatMap(r => r.findings)
const verified = await parallel(deduped.map(f => () => agent('verify ' + f.title, {schema: VERDICT})))
return { count: verified.filter(Boolean).length }
`
    expect(((await run(script)).value as { count: number }).count).toBe(2)
  })
})

describe("spec §2.9 — loop-until-count", () => {
  test("runs unchanged", async () => {
    const script = `export const meta = { name: 'until-count', description: 'Accumulate to a target' }
const BUGS = { type: 'object', properties: { bugs: { type: 'array' } } }
const bugs = []
while (bugs.length < 4) {
  const result = await agent('Find bugs in this codebase.', {schema: BUGS})
  bugs.push(...result.bugs)
  log(\`\${bugs.length}/4 found\`)
}
return { total: bugs.length }
`
    const result = await run(script)
    expect((result.value as { total: number }).total).toBeGreaterThanOrEqual(4)
    expect(result.logs.length).toBeGreaterThan(0)
  })
})

describe("spec §2.9 — loop-until-budget", () => {
  test("runs unchanged and terminates on the ceiling", async () => {
    const script = `export const meta = { name: 'until-budget', description: 'Scale depth to a budget' }
const BUGS = { type: 'object', properties: { bugs: { type: 'array' } } }
const bugs = []
while (budget.total && budget.remaining() > 1) {
  const result = await agent('Find bugs.', {schema: BUGS})
  bugs.push(...result.bugs)
}
return { rounds: bugs.length }
`
    const result = await execute(
      { script },
      { client: makeClient(), sessionID: "p", runId: "wf_parity02", budgetTotal: 6 },
    )
    // Each agent reports 2 output tokens, so a ceiling of 6 admits exactly three rounds.
    expect((result.value as { rounds: number }).rounds).toBe(3)
  })

  test("without a target the guard short-circuits, as the spec intends", async () => {
    // `budget.total` is null, so the loop never runs — which is why every documented budget loop
    // guards on it rather than on remaining() alone.
    const script = `export const meta = { name: 'no-target', description: 'Guarded loop' }
let rounds = 0
while (budget.total && budget.remaining() > 1) { await agent('x'); rounds++ }
return { rounds }
`
    expect(((await run(script)).value as { rounds: number }).rounds).toBe(0)
  })
})

describe("spec §2.9 — composed: find, dedup, diverse-lens panel, loop-until-dry", () => {
  test("runs unchanged", async () => {
    const script = `export const meta = { name: 'composed', description: 'The full composed example' }
const BUGS = { type: 'object', properties: { bugs: { type: 'array' } } }
const VERDICT = { type: 'object', properties: { isReal: { type: 'boolean' } } }
const FINDERS = [{prompt: 'finder a'}, {prompt: 'finder b'}]
const key = (b) => b.desc
const seen = new Set(), confirmed = []
let dry = 0
while (dry < 2) {
  const found = (await parallel(FINDERS.map(f => () =>
    agent(f.prompt, {phase: 'Find', schema: BUGS})))).filter(Boolean).flatMap(r => r.bugs)
  const fresh = found.filter(b => !seen.has(key(b)))
  if (!fresh.length) { dry++; continue }
  dry = 0; fresh.forEach(b => seen.add(key(b)))
  const judged = await parallel(fresh.map(b => () =>
    parallel(['correctness','security','repro'].map(lens => () =>
      agent(\`Judge "\${b.desc}" via the \${lens} lens — real?\`, {phase: 'Verify', schema: VERDICT})))
      .then(vs => ({ b, real: vs.filter(Boolean).filter(v => v.isReal).length >= 2 }))))
  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}
return { confirmed: confirmed.length }
`
    // Terminates: the second round finds nothing new, so `dry` reaches 2.
    const result = await run(script)
    expect((result.value as { confirmed: number }).confirmed).toBeGreaterThan(0)
  })
})

describe("spec §2.5 — the find-flaky-tests skeleton", () => {
  test("runs unchanged", async () => {
    const script = `export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test' },
  ],
}
const FLAKY_SCHEMA = { type: 'object', properties: { bugs: { type: 'array' } } }
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', {schema: FLAKY_SCHEMA})
phase('Fix')
const fixes = await parallel(flaky.bugs.map(b => () => agent('fix ' + b.desc)))
return { fixed: fixes.filter(Boolean).length }
`
    const result = await run(script)
    expect((result.value as { fixed: number }).fixed).toBe(1)
  })
})

describe("spec §3.3 — the gotchas checklist is enforced", () => {
  const META = "export const meta = { name: 'g', description: 'gotchas' }\n"
  const fails = async (body: string): Promise<string> => {
    try {
      await run(META + body)
      return "(did not throw)"
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  test.each([
    ["a non-literal meta", "", "export const meta = { name: NAME, description: 'y' }\n", "pure literal"],
    ["type annotations", "const x: string[] = []\n", "", "not TypeScript"],
    ["Date.now()", "const t = Date.now()\n", "", "Date.now()"],
    ["Math.random()", "const r = Math.random()\n", "", "Math.random()"],
    ["argless new Date()", "const d = new Date()\n", "", "new Date()"],
    ["an import", "import fs from 'node:fs'\n", "", "cannot import"],
  ])("rejects %s", async (_label, body, whole, expected) => {
    const message = whole === "" ? await fails(body) : await fails("").then(() => fails(whole.slice(META.length)))
    const actual = whole === "" ? message : await (async () => {
      try {
        await run(whole)
        return "(did not throw)"
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    })()
    expect(actual).toContain(expected)
  })

  test("parallel() rejects promises with an actionable message", async () => {
    // The single most common authoring error.
    const message = await fails("await parallel([agent('a')])\nreturn 1\n")
    expect(message).toContain("not promises")
    expect(message).toContain("() => agent(...)")
  })

  test("a stage returning null drops the item and skips its remaining stages", async () => {
    const script = `${META}let reached = 0
const out = await pipeline([1], () => null, () => { reached++; return 'x' })
return { out, reached }
`
    const result = (await run(script)).value as { out: unknown[]; reached: number }
    expect(result.out).toEqual([null])
    expect(result.reached).toBe(0)
  })
})
