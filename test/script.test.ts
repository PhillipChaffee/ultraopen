import { describe, expect, test } from "bun:test"
import { parse } from "../src/server/script/parse.js"
import { run } from "../src/server/script/sandbox.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"
import { MAX_SCRIPT_CHARS } from "../src/server/script/limits.js"

const META = `export const meta = { name: 'x', description: 'y' }\n`

const diag = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof WorkflowScriptError) return err.diagnostic
    throw err
  }
  throw new Error("expected the call to throw")
}

const noopGlobals = {
  agent: () => {},
  parallel: () => {},
  pipeline: () => {},
  phase: () => {},
  log: () => {},
  args: undefined,
  budget: { total: null, spent: () => 0, remaining: () => Infinity },
  workflow: () => {},
}

describe("parse — TypeScript rejection", () => {
  test("type annotations fail to parse", () => {
    const d = diag(() => parse(`${META}const x: string[] = []\n`))
    expect(d.kind).toBe("ParseError")
    expect(d.message).toContain("plain JavaScript, not TypeScript")
    expect(d.location?.line).toBe(2)
  })

  test("interfaces fail to parse", () => {
    expect(diag(() => parse(`${META}interface Foo { a: number }\n`)).kind).toBe("ParseError")
  })

  test("generics fail to parse", () => {
    expect(diag(() => parse(`${META}function f<T>(x: T) { return x }\n`)).kind).toBe("ParseError")
  })
})

describe("parse — pure-literal meta", () => {
  test("accepts a valid literal with phases", () => {
    const { meta } = parse(
      `export const meta = {\n  name: 'review',\n  description: 'Review changes',\n  phases: [{ title: 'Find' }, { title: 'Verify', detail: 'check' }],\n}\n`,
    )
    expect(meta.name).toBe("review")
    expect(meta.phases?.map((p) => p.title)).toEqual(["Find", "Verify"])
    expect(meta.phases?.[1]?.detail).toBe("check")
  })

  test("shorthand referencing a variable is rejected with a location", () => {
    const d = diag(() => parse(`const name = 'x'\nexport const meta = { name, description: 'y' }\n`))
    expect(d.kind).toBe("MetaError")
  })

  test("shorthand inside an otherwise-valid meta is caught", () => {
    const d = diag(() => parse(`export const meta = { name: 'a', description: 'b', phases: [{ title }] }\n`))
    expect(d.kind).toBe("MetaError")
    expect(d.message).toContain("shorthand")
    expect(d.location).toBeDefined()
  })

  test("template interpolation is rejected", () => {
    const d = diag(() => parse("export const meta = { name: `w-${1}`, description: 'y' }\n"))
    expect(d.kind).toBe("MetaError")
    expect(d.message).toContain("interpolation")
  })

  test("a template literal with NO interpolation is allowed", () => {
    const { meta } = parse("export const meta = { name: 'x', description: `line one\nline two` }\n")
    expect(meta.description).toContain("line one")
  })

  test("spread is rejected with its own message", () => {
    const d = diag(() => parse(`export const meta = { ...{}, name: 'x', description: 'y' }\n`))
    expect(d.message).toContain("spread")
  })

  test("function calls are rejected", () => {
    const d = diag(() => parse(`export const meta = { name: String('x'), description: 'y' }\n`))
    expect(d.kind).toBe("MetaError")
  })

  test("computed keys are rejected", () => {
    const d = diag(() => parse(`export const meta = { ['na' + 'me']: 'x', description: 'y' }\n`))
    expect(d.message).toContain("computed")
  })

  test("meta must be the FIRST statement", () => {
    const d = diag(() => parse(`const before = 1\nexport const meta = { name: 'x', description: 'y' }\n`))
    expect(d.kind).toBe("MetaError")
    expect(d.message).toContain("must begin with")
  })

  test("the spec's canonical script parses and ends with a top-level return", () => {
    const src = [
      "export const meta = {",
      "  name: 'review-changes',",
      "  description: 'Review changed files across dimensions, verify each finding',",
      "  phases: [{ title: 'Review' }, { title: 'Verify' }],",
      "}",
      "const DIMENSIONS = [{key: 'bugs', prompt: 'a'}, {key: 'perf', prompt: 'b'}]",
      "const results = await pipeline(",
      "  DIMENSIONS,",
      "  d => agent(d.prompt, {label: `review:${d.key}`, phase: 'Review'}),",
      "  review => parallel(review.findings.map(f => () =>",
      "    agent(`Verify: ${f.title}`, {phase: 'Verify'}).then(v => ({...f, verdict: v}))",
      "  ))",
      ")",
      "const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.isReal)",
      "return { confirmed }",
      "",
    ].join("\n")
    const { meta } = parse(src)
    expect(meta.name).toBe("review-changes")
    expect(meta.phases?.map((p) => p.title)).toEqual(["Review", "Verify"])
  })

  test("a missing meta is rejected", () => {
    expect(diag(() => parse(`const x = 1\n`)).kind).toBe("MetaError")
  })

  test("meta.name must be non-empty", () => {
    expect(diag(() => parse(`export const meta = { name: '', description: 'y' }\n`)).kind).toBe("MetaError")
  })

  test("meta is extracted WITHOUT running the body", () => {
    // If the body ran, this would throw.
    const { meta } = parse(`${META}throw new Error('body executed')\n`)
    expect(meta.name).toBe("x")
  })
})

describe("parse — determinism lint", () => {
  test("Date.now() is rejected statically", () => {
    const d = diag(() => parse(`${META}const t = Date.now()\n`))
    expect(d.kind).toBe("DeterminismError")
    expect(d.message).toContain("Date.now()")
    expect(d.location?.line).toBe(2)
  })

  test("Math.random() is rejected statically", () => {
    const d = diag(() => parse(`${META}const r = Math.random()\n`))
    expect(d.message).toContain("Math.random()")
  })

  test("argless new Date() is rejected", () => {
    const d = diag(() => parse(`${META}const d = new Date()\n`))
    expect(d.message).toContain("new Date()")
  })

  test("new Date(arg) is allowed", () => {
    const { body } = parse(`${META}const d = new Date(args.now)\n`)
    expect(body).toContain("Date(args.now)")
  })

  test("imports are rejected", () => {
    expect(diag(() => parse(`${META}import fs from 'node:fs'\n`)).kind).toBe("DeterminismError")
  })

  test("dynamic import is rejected", () => {
    expect(diag(() => parse(`${META}const m = await import('node:fs')\n`)).kind).toBe("DeterminismError")
  })

  test.each(["require", "process", "globalThis", "Bun", "eval", "global", "self"])("%s is rejected", (name) => {
    expect(diag(() => parse(`${META}const x = ${name}\n`)).kind).toBe("DeterminismError")
  })
})

describe("parse — export blanking preserves offsets", () => {
  test("line numbers are unchanged after blanking", () => {
    const src = `${META}\n\nconst x = 1\n`
    const { body } = parse(src)
    expect(body.length).toBe(src.length)
    expect(body.split("\n").length).toBe(src.split("\n").length)
    expect(body).not.toContain("export")
  })

  test("a TRAILING export is also blanked", () => {
    // Without this, the literal walk passes and AsyncFunction throws an opaque syntax error.
    const src = `${META}export function helper() { return 1 }\n`
    const { body } = parse(src)
    expect(body).not.toContain("export")
    expect(body.length).toBe(src.length)
  })
})

describe("parse — limits", () => {
  test("an oversized script is rejected explicitly", () => {
    const d = diag(() => parse(META + "//" + "x".repeat(MAX_SCRIPT_CHARS)))
    expect(d.kind).toBe("LimitError")
    expect(d.message).toContain(String(MAX_SCRIPT_CHARS))
  })
})

describe("sandbox — runtime traps", () => {
  const exec = (src: string) => {
    const { body } = parse(`${META}${src}`)
    return run(body, noopGlobals)
  }

  test("dynamic Date.now() throws at runtime too", async () => {
    // Static lint cannot see this; the runtime trap is the backstop.
    await expect(exec(`const k = 'now'; return Date[k]()\n`)).rejects.toThrow(/Date\.now\(\)/u)
  })

  test("dynamic Math.random() throws at runtime too", async () => {
    await expect(exec(`const k = 'random'; return Math[k]()\n`)).rejects.toThrow(/Math\.random\(\)/u)
  })

  test("new Date(0).getTime() still works", async () => {
    expect(await exec(`return new Date(0).getTime()\n`)).toBe(0)
  })

  test("Date.parse and Date.UTC still work", async () => {
    expect(await exec(`return Date.UTC(2020, 0, 1)\n`)).toBe(Date.UTC(2020, 0, 1))
  })

  test("Math.round still works", async () => {
    expect(await exec(`return Math.round(1.6)\n`)).toBe(2)
  })

  test("process is shadowed to undefined at runtime", async () => {
    // The static lint rejects any `process` reference outright, so bypass parse() to prove the
    // runtime shadow independently — it is the backstop for anything the lint cannot see.
    expect(await run(`return typeof process\n`, noopGlobals)).toBe("undefined")
    expect(await run(`return typeof globalThis\n`, noopGlobals)).toBe("undefined")
    expect(await run(`return typeof Bun\n`, noopGlobals)).toBe("undefined")
  })

  test("global and self are shadowed to undefined at runtime", async () => {
    // `global` is the Node host global and `self` the Bun one; either would reach real intrinsics
    // — `global.Date.now()` bypassed every trap before they were shadowed.
    expect(await run(`return typeof global\n`, noopGlobals)).toBe("undefined")
    expect(await run(`return typeof self\n`, noopGlobals)).toBe("undefined")
    await expect(run(`return global.Date.now()\n`, noopGlobals)).rejects.toThrow()
    await expect(run(`return Math.random()\n`, noopGlobals)).rejects.toThrow(/Math\.random\(\)/u)
  })

  test("require/fetch throw a clear error when reached dynamically", async () => {
    await expect(run(`return require('node:fs')\n`, noopGlobals)).rejects.toThrow(/require. is not available/u)
    await expect(run(`return fetch('http://x')\n`, noopGlobals)).rejects.toThrow(/fetch. is not available/u)
  })

  test("top-level await works", async () => {
    expect(await exec(`const v = await Promise.resolve(7); return v\n`)).toBe(7)
  })

  test("strict mode blocks an implicit global leak", async () => {
    const before = (globalThis as Record<string, unknown>)["__ultraopen_leak"]
    await expect(exec(`__ultraopen_leak = 42\n`)).rejects.toThrow()
    expect((globalThis as Record<string, unknown>)["__ultraopen_leak"]).toBe(before)
  })

  test("the body cannot see the plugin's module scope", async () => {
    expect(await exec(`return typeof AsyncFunction\n`)).toBe("undefined")
  })

  test("injected globals are callable and args is passed through", async () => {
    const { body } = parse(`${META}log('hi'); return args.value\n`)
    const seen: string[] = []
    const result = await run(body, { ...noopGlobals, log: (m: string) => seen.push(m), args: { value: 99 } })
    expect(result).toBe(99)
    expect(seen).toEqual(["hi"])
  })
})

describe("sandbox — remaining guards", () => {
  test("dynamically-constructed `new Date()` throws at runtime", async () => {
    // The static lint cannot see this form; the Proxy construct trap is the backstop.
    const body = `const D = Date; return new D()\n`
    await expect(run(body, noopGlobals)).rejects.toThrow(/new Date\(\)/u)
  })

  test("`new Date(...)` with arguments still constructs through the trap", async () => {
    const iso = await run(`return new Date(0).toISOString()\n`, noopGlobals)
    expect(iso).toBe("1970-01-01T00:00:00.000Z")
  })

  test("a body that cannot compile reports a ParseError rather than leaking a SyntaxError", async () => {
    // run() is reachable directly (e.g. by resume replaying a stored body), so it must not assume
    // parse() already validated the source.
    const promise = run(`if (\n`, noopGlobals)
    await expect(promise).rejects.toThrow(WorkflowScriptError)
    await expect(promise).rejects.toThrow(/failed to compile/u)
  })

  test("Function and importScripts are denied at runtime", async () => {
    await expect(run(`return Function('return 1')\n`, noopGlobals)).rejects.toThrow(/Function. is not available/u)
    await expect(run(`return importScripts('x')\n`, noopGlobals)).rejects.toThrow(/importScripts. is not available/u)
  })

  test("__dirname and __filename are undefined", async () => {
    expect(await run(`return [typeof __dirname, typeof __filename]\n`, noopGlobals)).toEqual(["undefined", "undefined"])
  })
})

describe("sandbox — Date proxy passthrough", () => {
  test("non-function Date statics pass through unbound", async () => {
    // The `get` trap binds functions but must return plain values untouched.
    expect(await run(`return Date.name\n`, noopGlobals)).toBe("Date")
    expect(await run(`return Date.length\n`, noopGlobals)).toBe(7)
  })

  test("Date.parse works through the bound-function branch", async () => {
    expect(await run(`return Date.parse('1970-01-01T00:00:00.000Z')\n`, noopGlobals)).toBe(0)
  })

  test("instances keep their prototype methods", async () => {
    expect(await run(`const d = new Date(86400000); return d.getUTCDate()\n`, noopGlobals)).toBe(2)
  })
})

describe("sandbox — documented escape boundary", () => {
  test("the literal `.constructor` route is rejected statically", () => {
    // `({}).constructor.constructor` is the real Function constructor, which reaches the host
    // realm and an untrapped Date.now — silently defeating resume. Verified reachable before
    // this rule existed.
    const d = diag(() => parse(`${META}const h = ({}).constructor.constructor('return globalThis')()\n`))
    expect(d.kind).toBe("DeterminismError")
    expect(d.message).toContain("constructor")
    expect(d.location).toBeDefined()
  })

  test("a bare .constructor read is rejected too", () => {
    expect(diag(() => parse(`${META}const c = agent.constructor\n`)).kind).toBe("DeterminismError")
  })

  test("ordinary property access is unaffected", () => {
    const { body } = parse(`${META}const r = await agent('x'); return r.findings.length\n`)
    expect(body).toContain("r.findings.length")
  })

  test("KNOWN LIMIT: a computed constructor access still gets through the lint", () => {
    // Documented in sandbox.ts rather than fixed: the threat model is determinism, not
    // confinement — the authoring model already holds bash. This test pins the boundary so a
    // future reader knows it is a decision, not an oversight.
    const { body } = parse(`${META}const c = ({})["const" + "ructor"]\n`)
    expect(body).toContain('"const" + "ructor"')
  })
})
