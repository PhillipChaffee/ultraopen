/**
 * Node parity for the script sandbox.
 *
 * opencode ships a Node build (`script/build-node.ts`) and the plugin input itself degrades when
 * `typeof Bun === "undefined"`, so every sandbox guarantee must hold on plain Node — not just
 * under `bun test`. Bun-only behaviour here would fail silently in exactly the environments we
 * cannot observe.
 *
 * Run: bun run test:node   (builds to dist-test/ first, then `node --test`)
 *
 * Deliberately NOT named `*.test.mjs`: bun test would discover it and measure the dist-test
 * bundles (including bundled acorn) as source, diluting the coverage gate.
 */

import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"

const root = join(import.meta.dirname, "..", ".."),
 outdir = join(root, "dist-test")

let parse,
 run,
 WorkflowScriptError

before(async () => {
  execFileSync(
    "bun",
    [
      "build",
      "src/server/script/parse.ts",
      "src/server/script/sandbox.ts",
      "src/server/script/errors.ts",
      "--outdir",
      "dist-test",
      "--target",
      "node",
      "--format",
      "esm",
      // --splitting is REQUIRED, not an optimisation. Without it Bun inlines a private copy of
      // every shared module into each entry, so parse.js and errors.js get DIFFERENT
      // WorkflowScriptError classes and `instanceof` across the boundary silently returns false.
      // The shipped dual-entry build (./server + ./tui) has the same hazard.
      "--splitting",
    ],
    { cwd: root, stdio: "pipe" },
  )
  ;({ parse } = await import(join(outdir, "parse.js")))
  ;({ run } = await import(join(outdir, "sandbox.js")))
  ;({ WorkflowScriptError } = await import(join(outdir, "errors.js")))
})

after(() => {
  rmSync(outdir, { recursive: true, force: true })
})

const META = "export const meta = { name: 'x', description: 'y' }\n",
 globals = {
  agent: () => {},
  parallel: () => {},
  pipeline: () => {},
  phase: () => {},
  log: () => {},
  args: { value: 5 },
  budget: { total: null, spent: () => 0, remaining: () => Number.POSITIVE_INFINITY },
  workflow: () => {},
},
 exec = (source) => run(parse(META + source).body, globals)

describe("sandbox parity on Node", () => {
  test("executes a body and returns its value", async () => {
    assert.equal(await exec("return args.value\n"), 5)
  })

  test("supports top-level await", async () => {
    assert.equal(await exec("const v = await Promise.resolve(7); return v\n"), 7)
  })

  test("allows legitimate Date and Math usage", async () => {
    assert.equal(await exec("return new Date(0).getTime()\n"), 0)
    assert.equal(await exec("return Math.round(1.6)\n"), 2)
  })

  test("traps Date.now() and Math.random() reached dynamically", async () => {
    await assert.rejects(() => exec("const k='now'; return Date[k]()\n"), /Date\.now\(\)/u)
    await assert.rejects(() => exec("const k='random'; return Math[k]()\n"), /Math\.random\(\)/u)
  })

  test("shadows Node globals", async () => {
    assert.equal(await run("return typeof process\n", globals), "undefined")
    assert.equal(await run("return typeof globalThis\n", globals), "undefined")
    // `global` is Node's host global; unshadowed, `global.Date.now()` bypassed every trap.
    assert.equal(await run("return typeof global\n", globals), "undefined")
    // Node has no `self`; the shadow must be harmless there too.
    // oxlint-disable-next-line unicorn/prefer-global-this -- the alias shadowing is exactly what this asserts
    assert.equal(typeof self, "undefined")
    await assert.rejects(() => run("return require('node:fs')\n", globals), /is not available/u)
  })

  test("rejects TypeScript syntax", () => {
    assert.throws(() => parse(`${META}const x: string[] = []\n`), /not TypeScript/u)
  })

  test("rejects a non-literal meta", () => {
    assert.throws(() => parse("export const meta = { name, description: 'y' }\n"), /shorthand/u)
  })

  test("rejects Date.now() statically with a location", () => {
    try {
      parse(`${META}const t = Date.now()\n`)
      assert.fail("expected a throw")
    } catch (error) {
      assert.ok(error instanceof WorkflowScriptError)
      assert.equal(error.diagnostic.location.line, 2)
    }
  })

  test("strict mode prevents implicit global leaks", async () => {
    await assert.rejects(() => exec("__ultraopen_node_leak = 1\n"))
    assert.equal(globalThis.__ultraopen_node_leak, undefined)
  })
})
