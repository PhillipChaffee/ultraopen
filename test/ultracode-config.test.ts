import { describe, expect, test } from "bun:test"
import { WORKFLOW_TOOL } from "../src/server/bridge/permission.js"
import { installConfig } from "../src/server/ultracode/config.js"
import type { MutableConfig } from "../src/server/ultracode/config.js"

/** Narrows an installed block for property inspection — the schema types these fields as `unknown`. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

describe("installConfig — agent", () => {
  test("creates config.agent.ultracode with mode, description, permission and options", () => {
    const config: MutableConfig = {}
    installConfig(config, {})

    const agent = asRecord(asRecord(config.agent)["ultracode"])
    expect(agent["mode"]).toBe("primary")
    expect(typeof agent["description"]).toBe("string")
    expect((agent["description"] as string).length).toBeGreaterThan(0)
    expect(agent["permission"]).toEqual({ [WORKFLOW_TOOL]: "ask" })
    expect(agent["options"]).toEqual({ ultracode: true })
  })

  test("carries no prompt key", () => {
    // An agent prompt REPLACES the provider base prompt instead of appending to it, which would
    // lobotomise the agent — the ultracode instruction is injected elsewhere instead.
    const config: MutableConfig = {}
    installConfig(config, {})

    const agent = asRecord(asRecord(config.agent)["ultracode"])
    expect("prompt" in agent).toBe(false)
  })

  test("carries no variant key", () => {
    // An agent-configured variant is only honoured when the resolved model equals the agent's own
    // configured model, so setting one here would silently do nothing for a user on any other model.
    const config: MutableConfig = {}
    installConfig(config, {})

    const agent = asRecord(asRecord(config.agent)["ultracode"])
    expect("variant" in agent).toBe(false)
  })

  test("a user's existing config.agent.ultracode block wins", () => {
    // User config is applied BEFORE plugin config hooks run, so a straight assignment here would
    // clobber the user's overrides — the installer must spread the user's block last.
    const config: MutableConfig = { agent: { ultracode: { description: "mine", model: "x/y" } } }
    installConfig(config, {})

    const agent = asRecord(asRecord(config.agent)["ultracode"])
    expect(agent["description"]).toBe("mine")
    expect(agent["model"]).toBe("x/y")
  })
})

describe("installConfig — command", () => {
  test("creates config.command.ultracode with a non-empty string template", () => {
    // The command service calls hints(template) eagerly while building its state, so a missing or
    // non-string template throws there and takes out EVERY command for the directory, including /init.
    const config: MutableConfig = {}
    installConfig(config, {})

    const command = asRecord(asRecord(config.command)["ultracode"])
    expect(typeof command["template"]).toBe("string")
    expect((command["template"] as string).length).toBeGreaterThan(0)
  })

  test("carries no agent key", () => {
    // Leaving it undefined means `cmd.agent ?? input.agent` preserves whichever primary agent the
    // user is already on, rather than force-switching them.
    const config: MutableConfig = {}
    installConfig(config, {})

    const command = asRecord(asRecord(config.command)["ultracode"])
    expect("agent" in command).toBe(false)
  })

  test("a user's existing config.command.ultracode block wins", () => {
    const config: MutableConfig = { command: { ultracode: { template: "mine", agent: "build" } } }
    installConfig(config, {})

    const command = asRecord(asRecord(config.command)["ultracode"])
    expect(command["template"]).toBe("mine")
    expect(command["agent"]).toBe("build")
  })
})

describe("installConfig — permission", () => {
  test("on an empty config, config.permission.workflow is 'ask'", () => {
    const config: MutableConfig = {}
    installConfig(config, {})

    expect(asRecord(config.permission)[WORKFLOW_TOOL]).toBe("ask")
  })

  test("an existing permission.workflow value is not overwritten", () => {
    const config: MutableConfig = { permission: { [WORKFLOW_TOOL]: "allow" } }
    installConfig(config, {})

    expect(asRecord(config.permission)[WORKFLOW_TOOL]).toBe("allow")
  })

  test("a string permission value is left untouched and installConfig does not throw", () => {
    // `config.permission` can legitimately be the scalar string "deny" rather than an object —
    // writing into it as if it were a record would throw at runtime or shred the user's setting.
    const config: MutableConfig = { permission: "deny" }

    expect(() => {
      installConfig(config, {})
    }).not.toThrow()
    expect(config.permission).toBe("deny")
  })
})

describe("installConfig — experimental.primary_tools", () => {
  test("on an empty config, experimental.primary_tools contains WORKFLOW_TOOL", () => {
    // Both `experimental` and `primary_tools` are optional in the schema, so an optional-chained
    // `.push()` would be a silent no-op on the overwhelmingly common default config.
    const config: MutableConfig = {}
    installConfig(config, {})

    expect(config.experimental?.primary_tools).toContain(WORKFLOW_TOOL)
  })

  test("an existing primary_tools array is preserved and appended to", () => {
    const config: MutableConfig = { experimental: { primary_tools: ["foo"] } }
    installConfig(config, {})

    expect(config.experimental?.primary_tools).toEqual(["foo", WORKFLOW_TOOL])
  })

  test("calling installConfig twice does not duplicate the primary_tools entry", () => {
    const config: MutableConfig = {}
    installConfig(config, {})
    installConfig(config, {})

    const tools = config.experimental?.primary_tools ?? []
    expect(tools.filter((tool) => tool === WORKFLOW_TOOL)).toHaveLength(1)
  })
})

describe("installConfig — skills", () => {
  test("appends a supplied skillsPath to config.skills.paths", () => {
    const config: MutableConfig = {}
    installConfig(config, { skillsPath: "/skills/workflow" })

    expect(config.skills?.paths).toEqual(["/skills/workflow"])
  })

  test("an existing skills.paths array is preserved and appended to", () => {
    const config: MutableConfig = { skills: { paths: ["/existing"] } }
    installConfig(config, { skillsPath: "/skills/workflow" })

    expect(config.skills?.paths).toEqual(["/existing", "/skills/workflow"])
  })

  test("config.skills is left untouched when skillsPath is undefined", () => {
    const config: MutableConfig = {}
    installConfig(config, {})

    expect(config.skills).toBeUndefined()
  })

  test("calling installConfig twice does not duplicate the skills path", () => {
    const config: MutableConfig = {}
    installConfig(config, { skillsPath: "/skills/workflow" })
    installConfig(config, { skillsPath: "/skills/workflow" })

    const paths = config.skills?.paths ?? []
    expect(paths.filter((path) => path === "/skills/workflow")).toHaveLength(1)
  })
})

describe("installConfig — idempotency", () => {
  test("calling installConfig twice produces the same result as calling it once", () => {
    const once: MutableConfig = {}
    installConfig(once, { skillsPath: "/skills/workflow" })

    const twice: MutableConfig = {}
    installConfig(twice, { skillsPath: "/skills/workflow" })
    installConfig(twice, { skillsPath: "/skills/workflow" })

    expect(twice).toEqual(once)
  })
})
