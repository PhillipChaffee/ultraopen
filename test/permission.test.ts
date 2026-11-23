import { describe, expect, test } from "bun:test"
import type { HostAgentInfo, HostPort, HostSessionInfo } from "../src/server/host/port.js"
import {
  childRuleset,
  configuredEffect,
  createAncestorLookup,
  evaluate,
  evaluateAncestors,
  isHidden,
  isHiddenByAncestors,
  normalizePermissionAction,
  resolveAncestorChain,
  shellInvokesOpencode,
  STATUS_TOOL,
  STRUCTURED_OUTPUT_TOOL,
  wildcardMatch,
  WORKFLOW_TOOL,
} from "../src/server/bridge/permission.js"
import type {
  AncestorPolicyLookup,
  PermissionRule,
  Ruleset,
} from "../src/server/bridge/permission.js"

function rule(action: string, effect: PermissionRule["effect"], resource = "*"): PermissionRule {
  return { action, resource, effect }
}

function session(
  id: string,
  options: {
    agent?: string
    permissions?: readonly PermissionRule[]
    metadata?: Record<string, unknown>
    parentID?: string
    directory?: string
  } = {},
): HostSessionInfo {
  return {
    id,
    projectID: "proj",
    directory: options.directory ?? "/work",
    outputTokens: 0,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
  }
}

function agent(id: string, permissions: readonly PermissionRule[] = []): HostAgentInfo {
  return { id, mode: "primary", hidden: false, permissions }
}

function lookupOf(input: {
  sessions?: Record<string, HostSessionInfo>
  agents?: Record<string, HostAgentInfo>
  defaultAgent?: (directory?: string) => string | undefined
}): AncestorPolicyLookup {
  return {
    getSession: (id) => Promise.resolve(input.sessions?.[id]),
    getAgent: (id) => Promise.resolve(input.agents?.[id]),
    defaultAgentID: (directory) => Promise.resolve(input.defaultAgent?.(directory)),
  }
}

function agentInfo(id: string, mode: HostAgentInfo["mode"], hidden = false): HostAgentInfo {
  return { id, mode, hidden, permissions: [] }
}

function hostOf(input: {
  agents?: readonly HostAgentInfo[]
  session?: HostSessionInfo | undefined
  rejectSession?: boolean
  rejectAgent?: boolean
  rejectAgents?: boolean
}): Pick<HostPort, "getSession" | "getAgent" | "listAgents"> {
  return {
    getSession: () =>
      input.rejectSession === true ? Promise.reject(new Error("transport down")) : Promise.resolve(input.session),
    getAgent: () =>
      input.rejectAgent === true ? Promise.reject(new Error("transport down")) : Promise.resolve(input.agents?.[0]),
    listAgents: () =>
      input.rejectAgents === true ? Promise.reject(new Error("transport down")) : Promise.resolve(input.agents ?? []),
  }
}

describe("wildcardMatch", () => {
  test.each(["", "read", "opencode run x", "/a/b/c"])('"*" matches %p', (value) => {
    expect(wildcardMatch(value, "*")).toBe(true)
  })

  test("matches an exact literal and rejects a different one", () => {
    expect(wildcardMatch("read", "read")).toBe(true)
    expect(wildcardMatch("read", "write")).toBe(false)
  })

  test("? matches exactly one character", () => {
    expect(wildcardMatch("cat", "c?t")).toBe(true)
    expect(wildcardMatch("ct", "c?t")).toBe(false)
    expect(wildcardMatch("coat", "c?t")).toBe(false)
  })

  test("backslashes are normalized to forward slashes in values and patterns", () => {
    expect(wildcardMatch(String.raw`/data/a\b\c.json`, "/data/*")).toBe(true)
    expect(wildcardMatch("/data/a/b", String.raw`\data\a\b`)).toBe(true)
  })

  test("a trailing ' *' also matches the bare word", () => {
    expect(wildcardMatch("opencode run x", "opencode *")).toBe(true)
    expect(wildcardMatch("opencode", "opencode *")).toBe(true)
    expect(wildcardMatch("opencodex", "opencode *")).toBe(false)
    expect(wildcardMatch("myopencode run", "opencode *")).toBe(false)
  })

  test("* crosses / at any depth", () => {
    expect(wildcardMatch("/data/a/b/c.json", "/data/*")).toBe(true)
  })

  test("regex metacharacters are escaped, not interpreted", () => {
    expect(wildcardMatch("axb", "a.b")).toBe(false)
    expect(wildcardMatch("a.b", "a.b")).toBe(true)
    expect(wildcardMatch("a+b", "a+b")).toBe(true)
  })

  test("matching is case-sensitive outside win32", () => {
    expect(wildcardMatch("READ", "read")).toBe(process.platform === "win32")
  })
})

describe("normalizePermissionAction", () => {
  test.each([
    ["bash", "shell"],
    ["task", "subagent"],
    ["write", "edit"],
    ["apply_patch", "edit"],
    ["patch", "edit"],
    ["list_mcp_resources", "opencode_list_mcp_resources"],
    ["read_mcp_resource", "opencode_read_mcp_resource"],
    ["shell", "shell"],
    ["read", "read"],
    ["StructuredOutput", "StructuredOutput"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePermissionAction(input)).toBe(expected)
  })
})

describe("evaluate", () => {
  test("defaults to ask when no rule matches", () => {
    expect(evaluate("read", "*", [])).toBe("ask")
  })

  test("last matching rule wins — an allow after a deny reverses the outcome", () => {
    const ruleset: Ruleset = [rule("read", "deny"), rule("read", "allow")]
    expect(evaluate("read", "*", ruleset)).toBe("allow")
  })

  test('a {action:"*", resource:"*"} rule matches any tool', () => {
    expect(evaluate("anything-at-all", "whatever args", [rule("*", "allow")])).toBe("allow")
  })

  test("normalizes the queried action before matching", () => {
    expect(evaluate("bash", "ls", [rule("shell", "deny")])).toBe("deny")
    expect(evaluate("task", "*", [rule("subagent", "deny")])).toBe("deny")
    expect(evaluate("write", "src/a.ts", [rule("edit", "deny")])).toBe("deny")
  })

  test("normalizes the rule action too", () => {
    expect(evaluate("shell", "ls", [rule("bash", "deny")])).toBe("deny")
  })

  test("matches the resource with wildcard semantics", () => {
    expect(evaluate("edit", "/repo/src/a.ts", [rule("edit", "deny", "/repo/*")])).toBe("deny")
    expect(evaluate("edit", "/other/src/a.ts", [rule("edit", "deny", "/repo/*")])).not.toBe("deny")
  })
})

describe("configuredEffect — one ruleset's effect across every resource", () => {
  test("a ruleset with no matching rule reads ask, the host default", () => {
    expect(configuredEffect("edit", ["/work/a.ts"], [])).toBe("ask")
  })

  test("an explicit allow reads allow", () => {
    expect(configuredEffect("edit", ["/work/a.ts"], [rule("edit", "allow")])).toBe("allow")
  })

  test("any resource left at ask makes the whole request ask", () => {
    const ruleset: Ruleset = [rule("edit", "allow", "/work/src/**")]
    expect(configuredEffect("edit", ["/work/src/a.ts", "/work/other/b.ts"], ruleset)).toBe("ask")
  })

  test("a narrow deny wins over a broad allow for that resource", () => {
    const ruleset: Ruleset = [rule("edit", "allow", "*"), rule("edit", "deny", "/work/secret/**")]
    expect(configuredEffect("edit", ["/work/secret/key.pem"], ruleset)).toBe("deny")
    expect(configuredEffect("edit", ["/work/src/a.ts"], ruleset)).toBe("allow")
  })

  test("normalizes the queried action and the rule actions", () => {
    expect(configuredEffect("write", ["/work/a.ts"], [rule("edit", "allow")])).toBe("allow")
    expect(configuredEffect("edit", ["/work/a.ts"], [rule("write", "allow")])).toBe("allow")
  })
})

describe("isHidden", () => {
  test("true when the last matching rule is a deny with the literal * resource", () => {
    expect(isHidden("read", [rule("read", "deny")])).toBe(true)
  })

  test("false when the resource is workflow:* instead of *", () => {
    expect(isHidden("workflow", [rule("workflow", "deny", "workflow:*")])).toBe(false)
  })

  test("false when a later allow overrides an earlier deny", () => {
    expect(isHidden("read", [rule("read", "deny"), rule("read", "allow")])).toBe(false)
  })

  test("false for a tool with no matching rule", () => {
    expect(isHidden("read", [rule("write", "deny")])).toBe(false)
  })

  test("denying edit also hides write, apply_patch, and patch", () => {
    const rules = [rule("edit", "deny")]
    expect(isHidden("edit", rules)).toBe(true)
    expect(isHidden("write", rules)).toBe(true)
    expect(isHidden("apply_patch", rules)).toBe(true)
    expect(isHidden("patch", rules)).toBe(true)
  })

  test("denying the V2 MCP action hides the legacy tool ids", () => {
    const rules = [rule("opencode_list_mcp_resources", "deny"), rule("opencode_read_mcp_resource", "deny")]
    expect(isHidden("list_mcp_resources", rules)).toBe(true)
    expect(isHidden("read_mcp_resource", rules)).toBe(true)
  })

  test("a later narrow rule for the same action means NOT hidden", () => {
    const rules = [rule("grep", "deny"), rule("grep", "allow", "src/**")]
    expect(isHidden("grep", rules)).toBe(false)
  })
})

describe("childRuleset", () => {
  test.each([WORKFLOW_TOOL, STATUS_TOOL, "subagent", "todowrite"])(
    "denies %s with the literal * resource",
    (tool) => {
      expect(childRuleset({})).toContainEqual(rule(tool, "deny"))
    },
  )

  test.each([WORKFLOW_TOOL, STATUS_TOOL, "subagent", "todowrite"])(
    "hides %s from the model entirely",
    (tool) => {
      expect(isHidden(tool, childRuleset({}))).toBe(true)
    },
  )

  test("contains no blanket deny-all rule, which would also strip StructuredOutput", () => {
    const ruleset = childRuleset({ structured: true, disallowedTools: ["read"] })
    expect(ruleset).not.toContainEqual(rule("*", "deny"))
  })

  test("with structured:true, the last rule is the StructuredOutput allow", () => {
    const ruleset = childRuleset({ structured: true })
    expect(ruleset.at(-1)).toEqual(rule(STRUCTURED_OUTPUT_TOOL, "allow"))
  })

  test("StructuredOutput survives an inherited blanket deny when structured", () => {
    const ruleset = childRuleset({ inherited: [rule("*", "deny")], structured: true })
    expect(isHidden(STRUCTURED_OUTPUT_TOOL, ruleset)).toBe(false)
  })

  test("omits StructuredOutput entirely when the child is not structured", () => {
    const ruleset = childRuleset({})
    expect(ruleset.some((candidate) => candidate.action === STRUCTURED_OUTPUT_TOOL)).toBe(false)
  })

  test("inherited denies are carried down ahead of our own rules", () => {
    const ruleset = childRuleset({ inherited: [rule("read", "deny")] }),
      inheritedIndex = ruleset.findIndex((candidate) => candidate.action === "read"),
      ownIndex = ruleset.findIndex((candidate) => candidate.action === WORKFLOW_TOOL)
    expect(inheritedIndex).toBeGreaterThanOrEqual(0)
    expect(inheritedIndex).toBeLessThan(ownIndex)
  })

  test("drops an inherited allow for an ordinary action", () => {
    const ruleset = childRuleset({ inherited: [rule("read", "allow")] })
    expect(ruleset).not.toContainEqual(rule("read", "allow"))
  })

  test("keeps an inherited external_directory rule for every effect", () => {
    const inherited: Ruleset = [
      rule("external_directory", "allow"),
      rule("external_directory", "ask"),
    ]
    expect(childRuleset({ inherited })).toEqual(expect.arrayContaining(inherited))
  })

  test.each(["read", "grep"])("disallowedTools denies and hides %s", (tool) => {
    const ruleset = childRuleset({ disallowedTools: ["read", "grep"] })
    expect(ruleset).toContainEqual(rule(tool, "deny"))
    expect(isHidden(tool, ruleset)).toBe(true)
  })

  test("normalizes disallowedTools before denying", () => {
    const ruleset = childRuleset({ disallowedTools: ["bash", "write", "task"] })
    expect(ruleset).toContainEqual(rule("shell", "deny"))
    expect(ruleset).toContainEqual(rule("edit", "deny"))
    expect(ruleset).toContainEqual(rule("subagent", "deny"))
  })

  test.each([
    "opencode run x",
    "opencode",
    "bunx opencode run",
    "npx opencode run",
    "/usr/local/bin/opencode run",
  ])("shell blocks the nested-opencode command %p", (command) => {
    expect(evaluate("shell", command, childRuleset({}))).toBe("deny")
  })

  test("shell is not hidden — its denies are command resources, not the literal * resource", () => {
    expect(isHidden("shell", childRuleset({}))).toBe(false)
  })

  test("shell allows ordinary commands", () => {
    expect(evaluate("shell", "ls -la", childRuleset({}))).not.toBe("deny")
  })

  test("re-asserts a blanket shell deny inherited from the parent", () => {
    const ruleset = childRuleset({ inherited: [rule("shell", "deny")] }),
      lastShell = ruleset.findLast((candidate) => candidate.action === "shell")
    expect(isHidden("shell", ruleset)).toBe(true)
    expect(lastShell).toEqual(rule("shell", "deny"))
  })

  test("an inherited blanket deny still hides shell", () => {
    const ruleset = childRuleset({ inherited: [rule("*", "deny")] })
    expect(isHidden("shell", ruleset)).toBe(true)
  })

  test("shell stays usable when nothing inherited hid it", () => {
    expect(isHidden("shell", childRuleset({}))).toBe(false)
  })

  test("adds the original-checkout edit deny when blockDirectory is set", () => {
    const ruleset = childRuleset({ blockDirectory: "/work/orig" })
    expect(ruleset).toContainEqual(rule("edit", "deny", "/work/orig/**"))
    expect(evaluate("edit", "/work/orig/src/a.ts", ruleset)).toBe("deny")
    expect(evaluate("edit", "/work/wt/src/a.ts", ruleset)).not.toBe("deny")
  })

  test("puts the original-checkout edit deny before the trailing StructuredOutput allow", () => {
    const ruleset = childRuleset({ blockDirectory: "/work/orig", structured: true })
    expect(ruleset.at(-2)).toEqual(rule("edit", "deny", "/work/orig/**"))
    expect(ruleset.at(-1)).toEqual(rule(STRUCTURED_OUTPUT_TOOL, "allow"))
  })
})

describe("shellInvokesOpencode", () => {
  test.each([
    ["opencode run", true],
    ["opencode", true],
    ["/usr/local/bin/opencode run", true],
    ["./opencode", true],
    ["../bin/opencode serve", true],
    ["env FOO=1 opencode", true],
    ["env -i FOO=1 opencode run", true],
    ["FOO=1 opencode run", true],
    ["bunx opencode", true],
    ["bunx --bun opencode run", true],
    ["npx opencode", true],
    ["npx -y opencode run", true],
    ['sh -c "opencode run"', true],
    ["bash -lc 'FOO=1 opencode run'", true],
    ['zsh -c "bunx opencode"', true],
    ["git status && opencode run", true],
    ["true; opencode", true],
    ["echo hi | opencode", true],
    ["(opencode run)", true],
    ["git status\nopencode run", true],
    ['npx -y sh -c "opencode run"', true],
    [String.raw`echo "say \"opencode\""`, false],
    [String.raw`r\g opencode src/`, false],
    ["git status", false],
    ["rg opencode src/", false],
    ['echo "no opencode here"', false],
    ["echo opencode", false],
    ["cat opencode.log", false],
    ["sh script.sh", false],
    ["npm run opencode", false],
    ["rg 'opencode run' .", false],
    ['echo "a; opencode"', false],
    ["", false],
  ])("shellInvokesOpencode(%p) === %p", (command, expected) => {
    expect(shellInvokesOpencode(command)).toBe(expected)
  })
})

describe("evaluateAncestors — #149 matrix", () => {
  const base = {
    childSessionID: "s-child",
    action: "edit",
    resources: ["src/a.ts"],
  } as const

  test("1. a parent agent's live deny narrows the child even when the child allows", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "plan" }) },
      agents: { plan: agent("plan", [rule("edit", "deny")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      childConfiguredEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("2. switching the parent from plan to build relaxes the next child evaluation", async () => {
    const makeLookup = (agentID: string, permissions: readonly PermissionRule[]): AncestorPolicyLookup =>
      lookupOf({
        sessions: { "s-parent": session("s-parent", { agent: agentID }) },
        agents: { [agentID]: agent(agentID, permissions) },
      })
    const denied = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      childConfiguredEffect: "allow",
      lookup: makeLookup("plan", [rule("edit", "deny")]),
    })
    const allowed = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      childConfiguredEffect: "allow",
      lookup: makeLookup("build", [rule("edit", "allow")]),
    })
    expect(denied.effect).toBe("deny")
    expect(allowed.effect).toBe("allow")
  })

  test("3. preserves Core's Allow always when the child configured ask and the user chose allow", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "asker" }) },
      agents: { asker: agent("asker", [rule("edit", "ask")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      childConfiguredEffect: "ask",
      lookup,
    })
    expect(result.effect).toBe("allow")
  })

  test("4. escalates a child allow to ask when an ancestor asks and the child configured allow", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "asker" }) },
      agents: { asker: agent("asker", [rule("edit", "ask")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      childConfiguredEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("ask")
  })

  test("5. a grandparent deny is transitive across the whole chain", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "worker",
          metadata: { ultraopen: { parentSessionID: "s-grand" } },
        }),
        "s-grand": session("s-grand", { agent: "plan" }),
      },
      agents: {
        worker: agent("worker", [rule("shell", "allow")]),
        plan: agent("plan", [rule("shell", "deny")]),
      },
    })
    const result = await evaluateAncestors({
      childSessionID: "s-child",
      parentSessionID: "s-parent",
      action: "shell",
      resources: ["ls -la"],
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("5b. falls back to native parentID for a non-ultraopen ancestor", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "worker",
          metadata: { ultraopen: { parentSessionID: "s-grand" } },
        }),
        "s-grand": session("s-grand", { agent: "sub", parentID: "s-great" }),
        "s-great": session("s-great", { agent: "plan" }),
      },
      agents: {
        worker: agent("worker", [rule("edit", "allow")]),
        sub: agent("sub", [rule("edit", "allow")]),
        plan: agent("plan", [rule("edit", "deny")]),
      },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("6a. fails closed when an ancestor session cannot be resolved", async () => {
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-missing",
      currentEffect: "allow",
      lookup: lookupOf({}),
    })
    expect(result.effect).toBe("deny")
    expect(result.message ?? "").toContain("s-missing")
  })

  test("6b. fails closed when an ancestor agent cannot be resolved", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "ghost" }) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
    expect(result.message ?? "").toContain("ghost")
  })

  test("6c. fails closed when no default agent can be resolved", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent") },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
    expect(result.message ?? "").toContain("agent")
  })

  test("6d. resolves the default agent when the session names none", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent") },
      agents: { build: agent("build", [rule("edit", "allow")]) },
      defaultAgent: () => "build",
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("allow")
  })

  test("7. fails closed on an ancestor cycle", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "build",
          metadata: { ultraopen: { parentSessionID: "s-child" } },
        }),
      },
      agents: { build: agent("build", [rule("edit", "allow")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
    expect(result.message ?? "").toContain("cycle")
  })

  test("7b. fails closed on a two-ancestor cycle", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "build",
          metadata: { ultraopen: { parentSessionID: "s-grand" } },
        }),
        "s-grand": session("s-grand", {
          agent: "build",
          metadata: { ultraopen: { parentSessionID: "s-parent" } },
        }),
      },
      agents: { build: agent("build", [rule("edit", "allow")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
    expect(result.message ?? "").toContain("cycle")
  })

  test("8. multi-resource evaluation denies when any resource is denied", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "build" }) },
      agents: {
        build: agent("build", [
          rule("edit", "allow", "*"),
          rule("edit", "deny", "/repo/secret/**"),
        ]),
      },
    })
    const result = await evaluateAncestors({
      childSessionID: "s-child",
      parentSessionID: "s-parent",
      action: "edit",
      resources: ["/repo/src/a.ts", "/repo/secret/key.pem"],
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("8b. multi-resource evaluation allows when every resource is allowed", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "build" }) },
      agents: { build: agent("build", [rule("edit", "allow")]) },
    })
    const result = await evaluateAncestors({
      childSessionID: "s-child",
      parentSessionID: "s-parent",
      action: "edit",
      resources: ["/repo/src/a.ts", "/repo/src/b.ts"],
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("allow")
  })

  test("a child deny is never widened by an ancestor allow", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "build" }) },
      agents: { build: agent("build", [rule("edit", "allow")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "deny",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("a child ask is preserved under an ancestor allow", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "build" }) },
      agents: { build: agent("build", [rule("edit", "allow")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "ask",
      lookup,
    })
    expect(result.effect).toBe("ask")
  })

  test("a parent deny wins over a current ask", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "plan" }) },
      agents: { plan: agent("plan", [rule("edit", "deny")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "ask",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("an undefined childConfiguredEffect still escalates an ancestor ask", async () => {
    const lookup = lookupOf({
      sessions: { "s-parent": session("s-parent", { agent: "asker" }) },
      agents: { asker: agent("asker", [rule("edit", "ask")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("ask")
  })

  test("malformed ultraopen metadata falls back to native parentID", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "worker",
          metadata: { ultraopen: "corrupt" },
          parentID: "s-grand",
        }),
        "s-grand": session("s-grand", { agent: "plan" }),
      },
      agents: {
        worker: agent("worker", [rule("edit", "allow")]),
        plan: agent("plan", [rule("edit", "deny")]),
      },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })

  test("session-level permissions override the ancestor agent's permissions", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "plan",
          permissions: [rule("edit", "allow")],
        }),
      },
      agents: { plan: agent("plan", [rule("edit", "deny")]) },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("allow")
  })

  test("the nearest ancestor deny beats a farther ancestor allow", async () => {
    const lookup = lookupOf({
      sessions: {
        "s-parent": session("s-parent", {
          agent: "plan",
          metadata: { ultraopen: { parentSessionID: "s-grand" } },
        }),
        "s-grand": session("s-grand", { agent: "build" }),
      },
      agents: {
        plan: agent("plan", [rule("edit", "deny")]),
        build: agent("build", [rule("edit", "allow")]),
      },
    })
    const result = await evaluateAncestors({
      ...base,
      parentSessionID: "s-parent",
      currentEffect: "allow",
      lookup,
    })
    expect(result.effect).toBe("deny")
  })
})

describe("resolveAncestorChain — single-pass ancestor resolution", () => {
  test("resolves each ancestor once and isHiddenByAncestors keeps tools with a narrower allow visible", async () => {
    let getSessionCalls = 0
    const parentRules: Ruleset = [
      rule("shell", "deny"),
      rule("shell", "allow", "git status"),
      rule("edit", "deny"),
    ]
    const lookup: AncestorPolicyLookup = {
      getSession: (id) => {
        getSessionCalls += 1
        return Promise.resolve(session(id, { agent: "build" }))
      },
      getAgent: () => Promise.resolve(agent("build", parentRules)),
      defaultAgentID: () => Promise.resolve("build"),
    }
    const chain = await resolveAncestorChain("child", "parent", lookup)
    expect(chain.ok).toBe(true)
    expect(getSessionCalls).toBe(1)
    if (!chain.ok) {throw new Error(chain.message)}
    expect(isHiddenByAncestors("edit", chain.rulesets)).toBe(true)
    expect(isHiddenByAncestors("shell", chain.rulesets)).toBe(false)
  })

  test("collects one ruleset per ancestor, nearest first", async () => {
    const lookup = lookupOf({
      sessions: {
        parent: session("parent", { agent: "near", metadata: { ultraopen: { parentSessionID: "grand" } } }),
        grand: session("grand", { agent: "far" }),
      },
      agents: {
        near: agent("near", [rule("edit", "ask")]),
        far: agent("far", [rule("edit", "deny")]),
      },
    })
    const chain = await resolveAncestorChain("child", "parent", lookup)
    if (!chain.ok) {throw new Error(chain.message)}
    expect(chain.rulesets).toEqual([[rule("edit", "ask")], [rule("edit", "deny")]])
    expect(isHiddenByAncestors("edit", chain.rulesets)).toBe(true)
    expect(isHiddenByAncestors("read", chain.rulesets)).toBe(false)
  })

  test("fails closed on a cycle without resolving the repeated ancestor twice", async () => {
    const fetched: string[] = []
    const lookup: AncestorPolicyLookup = {
      getSession: (id) => {
        fetched.push(id)
        return Promise.resolve(
          id === "parent"
            ? session("parent", { agent: "build", metadata: { ultraopen: { parentSessionID: "grand" } } })
            : session(id, { agent: "build", metadata: { ultraopen: { parentSessionID: "parent" } } }),
        )
      },
      getAgent: () => Promise.resolve(agent("build", [rule("edit", "allow")])),
      defaultAgentID: () => Promise.resolve("build"),
    }
    const chain = await resolveAncestorChain("child", "parent", lookup)
    expect(fetched).toEqual(["parent", "grand"])
    if (chain.ok) {throw new Error("expected a cycle failure")}
    expect(chain.message).toContain("cycle")
  })
})

describe("createAncestorLookup — host-backed lookup that fails closed", () => {
  test("defaults to build when the directory lists one", async () => {
    const lookup = createAncestorLookup(hostOf({ agents: [agentInfo("plan", "primary"), agentInfo("build", "primary")] }))
    expect(await lookup.defaultAgentID("/work")).toBe("build")
  })

  test("falls back to the first visible primary agent, skipping hidden and subagent entries", async () => {
    const lookup = createAncestorLookup(
      hostOf({
        agents: [agentInfo("hidden", "primary", true), agentInfo("worker", "subagent"), agentInfo("plan", "primary")],
      }),
    )
    expect(await lookup.defaultAgentID("/work")).toBe("plan")
  })

  test("returns undefined when no visible primary agent exists", async () => {
    const lookup = createAncestorLookup(
      hostOf({ agents: [agentInfo("hidden", "primary", true), agentInfo("worker", "subagent")] }),
    )
    expect(await lookup.defaultAgentID("/work")).toBeUndefined()
  })

  test("fails closed when session, agent, or agent-list lookups reject", async () => {
    const lookup = createAncestorLookup(
      hostOf({ agents: [agentInfo("build", "primary")], rejectSession: true, rejectAgent: true, rejectAgents: true }),
    )
    expect(await lookup.getSession("s")).toBeUndefined()
    expect(await lookup.getAgent("build")).toBeUndefined()
    expect(await lookup.defaultAgentID("/work")).toBeUndefined()
  })

  test("delegates successful lookups to the host", async () => {
    const parent = session("parent")
    const lookup = createAncestorLookup(hostOf({ agents: [agentInfo("build", "primary")], session: parent }))
    expect(await lookup.getSession("parent")).toEqual(parent)
    expect(await lookup.getAgent("build")).toEqual(agentInfo("build", "primary"))
  })
})
