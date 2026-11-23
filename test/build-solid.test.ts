import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildAll } from "../script/build.js"

/**
 * Guards the only two facts a unit test can prove about the shipped bundles.
 *
 * A build into a fresh temp directory keeps `bun test` runnable on a clean CI
 * checkout (no `dist/` required, nothing under the repository mutated) while
 * asserting:
 *   1. every entry exists;
 *   2. the TUI bundle carries NO `jsx-runtime` import, which is the regression
 *      that silently kills Solid reactivity inside an installed package;
 *   3. the TUI bundle keeps the host's `@opentui/solid` and
 *      `@opencode/plugin/tui` modules external, so it shares the host's
 *      reactive owner graph and plugin contract;
 *   4. the server bundle never emits a runtime import from the TUI-only
 *      auxiliary packages, which the server half must only `import type`.
 */

let outdir: string
let tui = ""
let server = ""
let rpc = ""

/** Injected failures — the gate must throw, never ship a partial bundle. */
const failedBuild = () => ({ success: false, logs: ["synthetic failure"] })
const noisyBuild = () => ({ success: false, logs: ["first", "second"] })

beforeAll(async () => {
  outdir = await mkdtemp(join(tmpdir(), "ultraopen-build-"))
  await buildAll(outdir)
  tui = await readFile(join(outdir, "tui.js"), "utf8")
  server = await readFile(join(outdir, "server.js"), "utf8")
  rpc = await readFile(join(outdir, "rpc.js"), "utf8")
})

afterAll(async () => {
  await rm(outdir, { recursive: true, force: true })
})

describe("TUI data module purity", () => {
  test("src/tui/data.ts has zero node:fs or node:path imports", async () => {
    const source = await Bun.file("src/tui/data.ts").text()
    // Both static imports and dynamic `import(...)` calls: the TUI data module must stay I/O-free
    // whichever form a future edit reaches for.
    expect(source).not.toMatch(/(?:from\s+|import\s*\(\s*)["']node:(?:fs|path)/u)
  })
})

describe("built bundles", () => {
  test("builds all three entries", () => {
    expect(tui.length).toBeGreaterThan(0)
    expect(server.length).toBeGreaterThan(0)
    expect(rpc.length).toBeGreaterThan(0)
  })

  test("tui.js never imports a jsx runtime", () => {
    expect(tui).not.toMatch(/@opentui\/solid\/jsx-runtime/u)
    expect(tui).not.toMatch(/@opentui\/solid\/jsx-dev-runtime/u)
  })

  test("tui.js keeps @opentui/solid and @opencode/plugin/tui external", () => {
    expect(tui).toMatch(/from\s+["']@opentui\/solid["']/u)
    expect(tui).toMatch(/from\s+["']@opencode\/plugin\/tui["']/u)
  })

  test("server.js has no runtime import from the TUI-only auxiliary packages", () => {
    expect(server).not.toMatch(/from\s+["']@opencode\/(?:schema|theme|client)(?:\/[^"']*)?["']/u)
    expect(server).not.toMatch(/import\(\s*["']@opencode\/(?:schema|theme|client)(?:\/[^"']*)?["']/u)
  })
})

describe("build gate", () => {
  test("a failed entry throws instead of shipping a partial bundle", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ultraopen-build-fail-"))
    const original = console.error
    console.error = () => undefined
    try {
      await expect(buildAll(dir, failedBuild)).rejects.toThrow(/Failed to build src\/server\/index\.ts/u)
    } finally {
      console.error = original
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a failed entry reports every build log before throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ultraopen-build-log-"))
    const errors: unknown[] = [],
     original = console.error
    console.error = (...values: unknown[]) => {errors.push(...values)}
    try {
      await buildAll(dir, noisyBuild).catch(() => undefined)
      expect(errors).toEqual(["first", "second"])
    } finally {
      console.error = original
      await rm(dir, { recursive: true, force: true })
    }
  })
})
