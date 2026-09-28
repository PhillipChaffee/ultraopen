import { describe, expect, test } from "bun:test"
import { parse } from "../src/server/script/parse.js"
import { lintUndefinedIdentifiers } from "../src/server/script/lint.js"
import type * as acorn from "acorn"
import { run } from "../src/server/script/sandbox.js"
import { WorkflowScriptError } from "../src/server/script/errors.js"
import { MAX_SCRIPT_CHARS } from "../src/server/script/limits.js"

const META = `export const meta = { name: 'x', description: 'y' }\n`

const parseThrow = (source: string): WorkflowScriptError => {
  try {
    parse(source)
    throw new Error("expected parse() to refuse the script")
  } catch (error) {
    if (error instanceof WorkflowScriptError) {return error}
    throw error
  }
},

 diag = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    if (error instanceof WorkflowScriptError) {
      return error.diagnostic
    }
    throw error
  }
  throw new Error("expected the call to throw")
},

 noopGlobals = {
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
    ].join("\n"),
     { meta } = parse(src)
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

describe("parse — args dereference flag", () => {
  // #78 layer 2, static half: a script that reads properties off `args` requires object args.
  // The flag is metadata for the sandbox launch gate, not a lint failure — a dereference is
  // legal when args IS an object.
  test("a plain args.X dereference is flagged with its location", () => {
    const { argsDereference } = parse(`${META}return args.repo\n`)
    expect(argsDereference).toEqual({ line: 2, column: 7, property: "repo", kind: "member" })
  })

  test("computed and optional dereferences are flagged too", () => {
    // `args["repo"]` and `args?.repo` poison prompts exactly like `args.repo` when args is a
    // scalar, so the flag covers every member form.
    expect(parse(`${META}return args["repo"]\n`).argsDereference?.property).toBe("")
    expect(parse(`${META}return args?.repo\n`).argsDereference?.property).toBe("repo")
  })

  test("destructuring reads are flagged too (#78: same poison, no MemberExpression)", () => {
    for (const source of [
      `const { repo } = args\n`,
      `const [first] = args\n`,
      `for (const item of args) { log(item) }\n`,
      `for (const key in args) { log(key) }\n`,
      // The leading semicolon is required: a bare `(` would continue the meta expression (ASI).
      `;({ repo } = args)\n`,
    ]) {
      const flagged = parse(`${META}${source}`).argsDereference
      expect(flagged?.property).toBe("")
      expect(flagged?.kind).toBe("destructure")
    }
  })

  test("a nested parameter NAMED args is falsely flagged — the documented known limit", () => {
    // The flag is syntactic, like the Date/Math bans: no scope tracking. A helper whose
    // parameter is named `args` reads as a dereference of the global. The gate message points
    // at the read (line:col), so the fix is a rename; this test pins the limit so a future
    // scope-aware lint can tighten it deliberately.
    const flagged = parse(`${META}const f = (args) => args.x\nreturn f("scalar")\n`).argsDereference
    expect(flagged?.property).toBe("x")
  })

  test("an aliased read is flagged like a direct dereference (#139)", () => {
    // `const a = args; a.x` poisons prompts exactly like `args.x` when args is a scalar —
    // the alias must carry the same flag kind so the sandbox start-gate treats it identically.
    const flagged = parse(`${META}const a = args\nreturn a.repo\n`).argsDereference
    expect(flagged).toEqual({ line: 3, column: 7, property: "repo", kind: "member" })
  })

  test("a destructuring read through an alias is flagged too (#139)", () => {
    // `const a = args; const { repo } = a` poisons prompts the same way — the destructure
    // branch must admit alias names, not just the literal args identifier.
    const flagged = parse(`${META}const a = args\nconst { repo } = a\nreturn repo\n`).argsDereference
    expect(flagged?.kind).toBe("destructure")
    expect(flagged?.property).toBe("")
  })

  test("an alias bound by assignment is flagged too (#139)", () => {
    // `a = args` (assignment form) binds the alias without a declarator; reads through it
    // poison prompts identically.
    const flagged = parse(`${META}let a\na = args\nreturn a.repo\n`).argsDereference
    expect(flagged?.kind).toBe("member")
    expect(flagged?.property).toBe("repo")
  })

  test("a re-bound alias is still flagged — the documented limit (#139)", () => {
    // Re-binding is not tracked: `let a = args; a = { repo: 1 }; a.repo` is legal with scalar
    // args but stays flagged (the launch gate false-refuses it). Pinned so a future scope-aware
    // lint can tighten this deliberately.
    const flagged = parse(`${META}let a = args\na = { repo: 1 }\nreturn a.repo\n`).argsDereference
    expect(flagged?.property).toBe("repo")
  })

  test("a nested parameter shadowing an alias name is falsely flagged — the documented limit (#139)", () => {
    // Same syntactic-limit class as the args-shadowing note: no scope tracking for alias names.
    const flagged = parse(`${META}const a = args\nconst g = (a) => a.x\nreturn g(args)\n`).argsDereference
    expect(flagged?.property).toBe("x")
  })

  test("an alias of args that is never member-read is not flagged (#139)", () => {
    // Binding an alias and passing it through whole is not a dereference.
    expect(parse(`${META}const a = args\nreturn a\n`).argsDereference).toBeUndefined()
  })

  test("a local object that is not an alias is not flagged (#139)", () => {
    expect(parse(`${META}const a = { repo: 1 }\nreturn a.repo\n`).argsDereference).toBeUndefined()
  })

  test("a script that passes args through whole is not flagged", () => {
    expect(parse(`${META}return args\n`).argsDereference).toBeUndefined()
  })

  test("a member read on another object is not flagged", () => {
    expect(parse(`${META}return Object.keys(args).length\n`).argsDereference).toBeUndefined()
    expect(parse(`${META}const other = { a: 1 }; return other.a\n`).argsDereference).toBeUndefined()
  })
})

describe("parse — undefined-identifier refusal (#144)", () => {
  // Layer 3: a script referencing an undeclared identifier is refused at PREPARE — zero tokens —
  // instead of dying mid-run at first reference (four organic instances in the corpus). The pass
  // is scope-aware: declarations resolve, intrinsics resolve (the sandbox compiles into the HOST
  // realm, so the runtime resolution is `name in globalThis`), the eight injected globals resolve.

  test("a read of an undeclared identifier throws naming it", () => {
    const error = parseThrow(`${META}return UNIT_RESULT.summary\n`)
    expect(error).toBeInstanceOf(WorkflowScriptError)
    expect(error.message).toContain("UNIT_RESULT")
    expect(error.diagnostic.kind).toBe("RuntimeError")
    expect(error.diagnostic.suggestions?.length ?? 0).toBeGreaterThan(0)
  })

  test("a read of an undeclared identifier inside a nested block or function throws too", () => {
    expect(() => parse(`${META}if (true) { log(LENSES[0]) }\n`)).toThrow(/LENSES/u)
    expect(() => parse(`${META}const f = () => DEFAULT_ROSTER.map(() => null)\nreturn f()\n`)).toThrow(/DEFAULT_ROSTER/u)
  })

  test("declared identifiers pass — including use-after-declare and function declarations", () => {
    expect(() => parse(`${META}const roster = ["a"]\nreturn roster.length\n`)).not.toThrow()
    expect(() => parse(`${META}return helper()\nfunction helper() { return 1 }\n`)).not.toThrow()
  })

  test("an export-default declaration is not a false refusal (#144 review blocker)", () => {
    // `export default function f() {}` blanks cleanly (blankExports supports it) and runs —
    // the undefined-identifier pass must not refuse it.
    expect(() => parse(`${META}export default function f() { return 1 }\nreturn f()\n`)).not.toThrow()
    expect(() => parse(`${META}export default class Repo { static tag = 1 }\nreturn Repo.tag\n`)).not.toThrow()
  })

  test("standard intrinsics pass — the sandbox compiles into the host realm", () => {
    expect(() => parse(`${META}return JSON.stringify({ now: Date.parse(args.at ?? 0), max: Math.max(1, 2) })\n`)).not.toThrow()
    expect(() => parse(`${META}const set = new Map([["k", new Set([1])]])\nreturn set\n`)).not.toThrow()
    expect(() => parse(`${META}return [Object, Array, Promise, Number, String, Boolean, RegExp, Error, TypeError, Symbol, Proxy, Reflect, WeakMap].length\n`)).not.toThrow()
    expect(() => parse(`${META}return [Infinity, NaN, undefined, 1, null].length\n`)).not.toThrow()
  })

  test("member property names are not identifier reads", () => {
    expect(() => parse(`${META}const wrap = { repo: 1 }\nreturn wrap.repo\n`)).not.toThrow()
    expect(() => parse(`${META}return args.impossiblePropertyName\n`)).not.toThrow()
  })

  test("a shorthand object property is a read of its name (#144 review finding)", () => {
    // `{ missing }` reads `missing` — acorn shares the key/value node, so the read must be
    // visited like any identifier read.
    expect(() => parse(`${META}const wrap = { missing }\nreturn 1\n`)).toThrow(/missing/u)
  })

  test("the eight injected globals pass", () => {
    expect(() => parse(`${META}phase("p")\nlog("l")\nconst budgetCheck = budget.total\nreturn await agent("x")\n`)).not.toThrow()
    expect(() => parse(`${META}const results = await parallel([() => agent("a")])\nreturn results.filter(Boolean).length\n`)).not.toThrow()
    expect(() => parse(`${META}const out = await pipeline([1], (prev) => prev)\nawait workflow({ script: "x" })\nreturn out.length\n`)).not.toThrow()
    expect(() => parse(`${META}return args\n`)).not.toThrow()
  })

  test("typeof guards and writes to undeclared names do not false-flag", () => {
    // Reads only: `typeof x` is the classic guard, and writes to undeclared names are caught by
    // strict mode at runtime — the lint stays out of both.
    expect(() => parse(`${META}if (typeof maybeMissing !== "undefined") { return maybeMissing }\nreturn null\n`)).not.toThrow()
    expect(() => parse(`${META}undeclaredWrite = 1\nreturn undeclaredWrite\n`)).not.toThrow()
  })

  test("function params and shadowing resolve — no false flags", () => {
    expect(() => parse(`${META}const f = (x) => x + 1\nreturn f(1)\n`)).not.toThrow()
    expect(() => parse(`${META}const x = 1\nconst g = () => { const x = 2; return x }\nreturn g() + x\n`)).not.toThrow()
    expect(() => parse(`${META}try { throw new Error("e") } catch (err) { return err.message }\n`)).not.toThrow()
  })

  test("var scoping and loop declarations pass", () => {
    expect(() => parse(`${META}for (let i = 0; i < 3; i++) { log(i) }\n`)).not.toThrow()
    expect(() => parse(`${META}for (const item of [1, 2]) { log(item) }\n`)).not.toThrow()
    expect(() => parse(`${META}function f() { var scoped = 1; return scoped }\nreturn f()\n`)).not.toThrow()
  })

  test("var escapes blocks to function scope; loop updates and computed members resolve", () => {
    expect(() => parse(`${META}function f() { { var leaked = 1 } return leaked }\nreturn f()\n`)).not.toThrow()
    expect(() => parse(`${META}const list = [1, 2, 3]\nlet total = 0\nfor (let i = 0; i < list.length; i++) { total += list[i] }\nreturn total\n`)).not.toThrow()
    expect(() => parse(`${META}const key = "repo"\nreturn args[key]\n`)).not.toThrow()
  })

  test("classes, methods, static blocks, and property definitions resolve", () => {
    expect(() => parse(`${META}const Klass = class Inner { static tag = 1; render() { return this.tag } }\nreturn new Klass().render()\n`)).not.toThrow()
    expect(() => parse(`${META}class Repo { static #count = 0; static get count() { return Repo.#count } }\nreturn Repo.count\n`)).not.toThrow()
    expect(() => parse(`${META}class Config { static x = 0; static { Config.x = 1 } }\nreturn Config.x\n`)).not.toThrow()
  })

  test("switch, catch, rest, assignment patterns, labels, shorthand, meta pass", () => {
    expect(() => parse(`${META}const kind = "a"\nswitch (kind) { case "a": { const local = 1; log(local); break } default: break }\n`)).not.toThrow()
    expect(() => parse(`${META}try { JSON.parse("{") } catch (err) { log(err.message) }\n`)).not.toThrow()
    expect(() => parse(`${META}const [first, ...others] = [1, 2, 3]\nreturn first + others.length\n`)).not.toThrow()
    expect(() => parse(`${META}let assigned\n;({ assigned = 1 } = { assigned: 2 })\nreturn assigned\n`)).not.toThrow()
    expect(() => parse(`${META}outer: for (const i of [1]) { break outer }\n`)).not.toThrow()
    expect(() => parse(`${META}const a = 1\nconst wrap = { a }\nreturn wrap.a\n`)).not.toThrow()
    expect(() => parse(`${META}const f = function named() { return named }\nreturn f()\n`)).not.toThrow()
    expect(() => parse(`${META}const f = function () { return new.target }\nreturn f()\n`)).not.toThrow()
    expect(() => parse(`${META}const v = typeof (1 + 1)\nreturn v\n`)).not.toThrow()
  })

  test("unknown node types descend generically (#144 synthetic AST)", () => {
    // Direct call with a node type acorn never emits: the generic-descent branch must still
    // visit Identifier reads inside it and resolve them through the same rules. A nested
    // VariableDeclarator exercises the declarator case the real walk never reaches directly.
    const fake = {
      type: "Program",
      body: [{
        type: "TotallyUnknownNode",
        kids: [
          { type: "VariableDeclarator", id: { type: "Identifier", name: "bound" }, init: { type: "Identifier", name: "JSON", loc: { start: { line: 1, column: 0 } } } },
          { type: "Identifier", name: "undeclaredThing", loc: { start: { line: 1, column: 0 } } },
        ],
      }],
    }
    expect(() => lintUndefinedIdentifiers(fake as unknown as acorn.Program)).toThrow(/undeclaredThing/u)
  })
})

describe("parse — export blanking preserves offsets", () => {
  test("line numbers are unchanged after blanking", () => {
    const src = `${META}\n\nconst x = 1\n`,
     { body } = parse(src)
    expect(body.length).toBe(src.length)
    expect(body.split("\n").length).toBe(src.split("\n").length)
    expect(body).not.toContain("export")
  })

  test("a TRAILING export is also blanked", () => {
    // Without this, the literal walk passes and AsyncFunction throws an opaque syntax error.
    const src = `${META}export function helper() { return 1 }\n`,
     { body } = parse(src)
    expect(body).not.toContain("export")
    expect(body.length).toBe(src.length)
  })
})

describe("parse — limits", () => {
  test("an oversized script is rejected explicitly", () => {
    const d = diag(() => parse(`${META  }//${  "x".repeat(MAX_SCRIPT_CHARS)}`))
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
    const { body } = parse(`${META}log('hi'); return args.value\n`),
     seen: string[] = [],
     result = await run(body, { ...noopGlobals, log: (m: string) => seen.push(m), args: { value: 99 } })
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

describe("sandbox — args launch gate (#78)", () => {
  // #78 layer 2, runtime half: the flag from the lint walk plus the runtime args decide at
  // script start — before the first agent() dispatch, so a bad call costs zero tokens.
  const deref = { line: 2, column: 7, property: "repo", kind: "member" } as const,
   gatedGlobals = (args: unknown, extra: Record<string, unknown> = {}) => {
    const agents: string[] = []
    return {
      globals: {
        ...noopGlobals,
        args,
        agent: (prompt: string): Promise<string> => {
          agents.push(prompt)
          return Promise.resolve("done")
        },
        ...extra,
      },
      agents,
    }
  }

  test("a dereferencing script throws at start when args is absent", async () => {
    const { body } = parse(`${META}return args.repo\n`)
    const { globals, agents } = gatedGlobals(undefined)
    await expect(run(body, globals, deref)).rejects.toThrow(/args arrived as nothing/u)
    expect(agents).toEqual([])
  })

  test("the throw names the received type and a short preview", async () => {
    const { body } = parse(`${META}return args.repo\n`)
    const { globals } = gatedGlobals("review-targets")
    const failure = (await run(body, globals, deref).catch((error: unknown) => error)) as WorkflowScriptError
    expect(failure).toBeInstanceOf(WorkflowScriptError)
    expect(failure.message).toContain("the string")
    expect(failure.message).toContain("review-targets")
    expect(failure.diagnostic.location).toEqual({ line: 2, column: 7 })
  })

  test("object and array args pass and the script reads them", async () => {
    const objectBody = parse(`${META}return args.repo\n`).body
    const { globals: objectGlobals } = gatedGlobals({ repo: "r" })
    expect(await run(objectBody, objectGlobals, deref)).toBe("r")
    const arrayBody = parse(`${META}return args[0]\n`).body
    const { globals: arrayGlobals } = gatedGlobals([7, 9])
    expect(await run(arrayBody, arrayGlobals, { line: 2, column: 7, property: "", kind: "member" })).toBe(7)
  })

  test("null args throw even though typeof null is object", async () => {
    const { body } = parse(`${META}return args.repo\n`)
    const { globals } = gatedGlobals(null)
    await expect(run(body, globals, deref)).rejects.toThrow(/args arrived as null/u)
  })

  test("a destructuring read names the shape in the throw", async () => {
    const { body, argsDereference } = parse(`${META}const { repo } = args\nreturn repo\n`)
    const { globals } = gatedGlobals("42")
    await expect(run(body, globals, argsDereference)).rejects.toThrow(/destructuring read off `args`/u)
  })

  test("an aliased-read script throws identically when args is absent (#139)", async () => {
    // Same gate, same zero-token cost: the alias must reach the gate as a member dereference.
    const { body, argsDereference } = parse(`${META}const a = args\nreturn a.repo\n`)
    const { globals, agents } = gatedGlobals(undefined)
    await expect(run(body, globals, argsDereference)).rejects.toThrow(/args arrived as nothing/u)
    expect(agents).toEqual([])
  })

  test("a script without dereferences keeps scalar args working", async () => {
    const { body } = parse(`${META}return args\n`)
    const { globals } = gatedGlobals("42")
    expect(await run(body, globals, undefined)).toBe("42")
    expect(await run(body, globals)).toBe("42")
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
