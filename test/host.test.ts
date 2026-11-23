import { describe, expect, test } from "bun:test"
import { classifyHost, isLongLivedHost } from "../src/server/tool/background.js"

/**
 * The V2 host shapes are live captures: every `--standalone` CLI command spawns
 * `serve --stdio --port 0`, whose stdin EOF kills the server immediately, while a service-owned
 * `serve`/`service`/`web`/`acp` outlives the CLI. A wrong classification in the dangerous
 * direction (freeing the turn in a process that dies) silently loses runs.
 */
describe("classifyHost", () => {
  test("serve --stdio is ephemeral — stdin EOF kills it with the parent CLI", () => {
    const argv = ["bun", "/$bunfs/root/opencode", "serve", "--stdio", "--port", "0"]
    expect(classifyHost(argv)).toBe("ephemeral")
    expect(isLongLivedHost(argv)).toBe(false)
  })

  test("serve without --stdio is a shared service, as are service, web and acp", () => {
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "serve", "--port", "4096"])).toBe("shared-service")
    expect(isLongLivedHost(["bun", "/$bunfs/root/opencode", "serve", "--port", "4096"])).toBe(true)
    for (const command of ["service", "serve", "web", "acp"]) {
      expect(classifyHost(["bun", "/$bunfs/root/opencode", command])).toBe("shared-service")
      expect(isLongLivedHost(["bun", "/$bunfs/root/opencode", command])).toBe(true)
    }
  })

  test("run and any --stdio host are ephemeral", () => {
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "run", "say hi"])).toBe("ephemeral")
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "--stdio"])).toBe("ephemeral")
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "serve", "--stdio"])).toBe("ephemeral")
  })

  test("the --stdio token outranks a long-lived command in the same argv", () => {
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "serve", "--stdio", "web"])).toBe("ephemeral")
  })

  test("an unknown shape falls back to ephemeral", () => {
    expect(classifyHost(["bun", "/$bunfs/root/opencode"])).toBe("ephemeral")
    expect(classifyHost(["bun", "/$bunfs/root/opencode", "github", "run-workflow"])).toBe("ephemeral")
    expect(classifyHost([])).toBe("ephemeral")
  })

  test("no argv argument classifies the current process", () => {
    // The default is process.argv, which under `bun test` is neither run nor a service.
    expect(classifyHost()).toBe("ephemeral")
    expect(isLongLivedHost()).toBe(false)
  })
})
