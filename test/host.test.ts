import { describe, expect, test } from "bun:test"
import { isLongLivedHost } from "../src/server/tool/background.js"

/**
 * The argv shapes are live captures from the installed opencode 1.18.31 binary
 * and from a Bun worker spawn — the evidence the host decision stands on. A
 * wrong classification in the dangerous direction (freeing the turn in a
 * process that dies) silently loses runs; these pin every observed shape.
 */
describe("isLongLivedHost", () => {
  test("one-shot `opencode run` keeps the pinned contract", () => {
    expect(isLongLivedHost(["bun", "/$bunfs/root/src/index.js", "run", "say hi"])).toBe(false)
  })

  test("the `run` token decides even among flags, and a dev checkout looks the same", () => {
    expect(isLongLivedHost(["bun", "src/index.ts", "run", "hi"])).toBe(false)
    expect(isLongLivedHost(["bun", "/$bunfs/root/src/index.js", "--print-logs", "run", "--format", "json", "prompt"])).toBe(false)
  })

  test("serve, web, acp and the interactive mini REPL keep the process alive", () => {
    for (const token of ["serve", "web", "acp", "--mini"]) {
      expect(isLongLivedHost(["bun", "/$bunfs/root/src/index.js", token])).toBe(true)
    }
  })

  test("the TUI's server is the worker thread, whose argv is the worker file alone", () => {
    expect(isLongLivedHost(["bun", "/$bunfs/root/src/cli/tui/worker.js"])).toBe(true)
    expect(isLongLivedHost(["bun", "/dev/checkout/src/tui/worker.ts"])).toBe(true)
  })

  test("windows separators in the worker path still count", () => {
    expect(isLongLivedHost(["bun", String.raw`C:\dist\cli\tui\worker.js`])).toBe(true)
  })

  test("an unknown shape keeps the pinned contract — freeing the turn in a process that dies loses the run", () => {
    expect(isLongLivedHost(["bun", "/$bunfs/root/src/index.js", "github", "run-workflow"])).toBe(false)
    expect(isLongLivedHost(["bun", "/$bunfs/root/src/index.js"])).toBe(false)
  })
})