import { describe, expect, test } from "bun:test"
import { childRuleset, evaluate, isHidden, STRUCTURED_OUTPUT_TOOL, wildcardMatch } from "../src/server/bridge/permission.js"
import type { PermissionRule, Ruleset } from "../src/server/bridge/permission.js"

describe("wildcardMatch", () => {
  test.each(["", "read", "opencode run x", "/a/b/c"])('"*" matches %p', (value) => {
    expect(wildcardMatch(value, "*")).toBe(true)
  })

  test("matches an exact literal", () => {
    expect(wildcardMatch("read", "read")).toBe(true)
  })

  test("does not match a different literal", () => {
    expect(wildcardMatch("read", "write")).toBe(false)
  })

  describe("opencode * trailing-args rule", () => {
    test.each([
      // The common case: a pattern with args after the tool name.
      ["opencode run x", true],
      // Trailing " *" also matches zero arguments — the bare word alone.
      ["opencode", true],
      // Must be anchored at a word boundary: a longer word sharing the prefix is not a match.
      ["opencodex", false],
      // Must be anchored at the start too: a suffix match is not enough.
      ["myopencode run", false],
    ])('wildcardMatch(%p, "opencode *") === %p', (value, expected) => {
      expect(wildcardMatch(value, "opencode *")).toBe(expected)
    })
  })

  test("* crosses / at any depth", () => {
    expect(wildcardMatch("/data/a/b/c.json", "/data/*")).toBe(true)
  })

  test("regex metacharacters in the pattern are escaped, not interpreted as regex", () => {
    // If "." were a real regex dot, this would match — it must not.
    expect(wildcardMatch("axb", "a.b")).toBe(false)
    expect(wildcardMatch("a.b", "a.b")).toBe(true)
  })

  test("+ is literal, not a regex quantifier", () => {
    expect(wildcardMatch("a+b", "a+b")).toBe(true)
  })
})

describe("evaluate", () => {
  test("defaults to ask when no rule matches", () => {
    expect(evaluate("read", "*", [])).toBe("ask")
  })

  test("last matching rule wins — an allow after a deny reverses the outcome", () => {
    const ruleset: Ruleset = [
      { permission: "read", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ]
    expect(evaluate("read", "*", ruleset)).toBe("allow")
  })

  test('a {permission:"*", pattern:"*"} rule matches any tool', () => {
    const ruleset: Ruleset = [{ permission: "*", pattern: "*", action: "allow" }]
    expect(evaluate("anything-at-all", "whatever args", ruleset)).toBe("allow")
  })
})

describe("isHidden", () => {
  test("true when the last matching rule is a deny with the literal * pattern", () => {
    const ruleset: Ruleset = [{ permission: "read", pattern: "*", action: "deny" }]
    expect(isHidden("read", ruleset)).toBe(true)
  })

  test("false when the pattern is workflow:* instead of * — the silent-failure case the code calls out", () => {
    const ruleset: Ruleset = [{ permission: "workflow", pattern: "workflow:*", action: "deny" }]
    expect(isHidden("workflow", ruleset)).toBe(false)
  })

  test("false when a later allow overrides an earlier deny", () => {
    const ruleset: Ruleset = [
      { permission: "read", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
    ]
    expect(isHidden("read", ruleset)).toBe(false)
  })

  test("false for a tool with no matching rule", () => {
    const ruleset: Ruleset = [{ permission: "write", pattern: "*", action: "deny" }]
    expect(isHidden("read", ruleset)).toBe(false)
  })
})

describe("childRuleset", () => {
  test.each(["workflow", "task", "todowrite"])("denies %s with the literal * pattern", (tool) => {
    const ruleset = childRuleset({})
    expect(ruleset).toContainEqual({ permission: tool, pattern: "*", action: "deny" })
  })

  test.each(["workflow", "task", "todowrite"])("hides %s from the model entirely", (tool) => {
    const ruleset = childRuleset({})
    expect(isHidden(tool, ruleset)).toBe(true)
  })

  test("contains no blanket deny-all rule, which would also strip StructuredOutput and kill the turn after billing", () => {
    const ruleset = childRuleset({ structured: true, disallowedTools: ["read"] })
    expect(ruleset).not.toContainEqual({ permission: "*", pattern: "*", action: "deny" })
  })

  test("with structured:true, the last rule is the StructuredOutput allow", () => {
    const ruleset = childRuleset({ structured: true })
    expect(ruleset.at(-1)).toEqual({ permission: STRUCTURED_OUTPUT_TOOL, pattern: "*", action: "allow" })
  })

  test("StructuredOutput is never hidden when structured, even under a parent's blanket deny", () => {
    // This is the exact scenario rule 3 in the childRuleset doc comment guards against: the
    // inherited blanket deny would otherwise be the last matching rule and disarm the turn.
    const ruleset = childRuleset({
      inherited: [{ permission: "*", pattern: "*", action: "deny" }],
      structured: true,
    })
    expect(isHidden(STRUCTURED_OUTPUT_TOOL, ruleset)).toBe(false)
  })

  test("omits StructuredOutput entirely when the child is not structured", () => {
    const ruleset = childRuleset({})
    expect(ruleset.some((rule) => rule.permission === STRUCTURED_OUTPUT_TOOL)).toBe(false)
  })

  test("inherited denies are carried down ahead of our own rules, so ours can still override them", () => {
    const inherited: Ruleset = [{ permission: "read", pattern: "*", action: "deny" }],
     ruleset = childRuleset({ inherited }),
     inheritedIndex = ruleset.findIndex((rule) => rule.permission === "read" && rule.action === "deny"),
     ownIndex = ruleset.findIndex((rule) => rule.permission === "workflow")
    expect(inheritedIndex).toBeGreaterThanOrEqual(0)
    expect(inheritedIndex).toBeLessThan(ownIndex)
  })

  test("drops an inherited allow rule for an ordinary permission", () => {
    const inherited: Ruleset = [{ permission: "read", pattern: "*", action: "allow" }],
     ruleset = childRuleset({ inherited })
    expect(ruleset).not.toContainEqual({ permission: "read", pattern: "*", action: "allow" })
  })

  test("keeps an inherited allow rule when the permission is external_directory", () => {
    const grant: PermissionRule = { permission: "external_directory", pattern: "*", action: "allow" },
     ruleset = childRuleset({ inherited: [grant] })
    expect(ruleset).toContainEqual(grant)
  })

  test.each(["read", "grep"])("disallowedTools denies %s with the literal * pattern", (tool) => {
    const ruleset = childRuleset({ disallowedTools: ["read", "grep"] })
    expect(ruleset).toContainEqual({ permission: tool, pattern: "*", action: "deny" })
  })

  test.each(["read", "grep"])("disallowedTools hides %s from the model", (tool) => {
    const ruleset = childRuleset({ disallowedTools: ["read", "grep"] })
    expect(isHidden(tool, ruleset)).toBe(true)
  })

  test("bash is not hidden — its denies are command patterns, not the literal * pattern", () => {
    const ruleset = childRuleset({})
    expect(isHidden("bash", ruleset)).toBe(false)
  })

  test("bash still blocks a nested opencode invocation by command pattern", () => {
    const ruleset = childRuleset({})
    expect(evaluate("bash", "opencode run x", ruleset)).toBe("deny")
  })

  test("bash allows ordinary commands that do not match a nested-opencode pattern", () => {
    const ruleset = childRuleset({})
    expect(evaluate("bash", "ls -la", ruleset)).not.toBe("deny")
  })
})

describe("childRuleset — inherited-hiding is preserved", () => {
  const blanketDeny = [{ permission: "*", pattern: "*", action: "deny" as const }]

  test("an inherited blanket deny still hides bash", () => {
    // Regression: the narrow `opencode *` denies are appended AFTER the inherited rules, and
    // Permission.disabled reads the LAST rule matching the permission and checks ITS pattern.
    // Without the explicit re-hide, those narrow patterns UN-HIDE bash — handing a workflow
    // child more privilege than a plain `task` child of the same parent.
    expect(isHidden("bash", childRuleset({ inherited: blanketDeny }))).toBe(true)
  })

  test("bash stays usable when nothing inherited hid it", () => {
    expect(isHidden("bash", childRuleset({}))).toBe(false)
  })

  test("StructuredOutput survives an inherited blanket deny", () => {
    expect(isHidden("StructuredOutput", childRuleset({ inherited: blanketDeny, structured: true }))).toBe(false)
  })

  test("workflow stays hidden regardless of what was inherited", () => {
    for (const inherited of [undefined, blanketDeny, [{ permission: "workflow", pattern: "*", action: "allow" as const }]]) {
      expect(isHidden("workflow", childRuleset({ inherited }))).toBe(true)
    }
  })
})

describe("isHidden — opencode permission aliasing", () => {
  test("denying `edit` also hides write and apply_patch", () => {
    const rules = [{ permission: "edit", pattern: "*", action: "deny" as const }]
    expect(isHidden("write", rules)).toBe(true)
    expect(isHidden("apply_patch", rules)).toBe(true)
    expect(isHidden("edit", rules)).toBe(true)
  })

  test("denying `read` also hides the MCP resource tools", () => {
    const rules = [{ permission: "read", pattern: "*", action: "deny" as const }]
    expect(isHidden("read_mcp_resource", rules)).toBe(true)
    expect(isHidden("list_mcp_resources", rules)).toBe(true)
  })

  test("a later narrow rule for the same permission means NOT hidden", () => {
    // The search matches on permission only; the pattern is checked on whatever it finds.
    const rules = [
      { permission: "grep", pattern: "*", action: "deny" as const },
      { permission: "grep", pattern: "src/**", action: "allow" as const },
    ]
    expect(isHidden("grep", rules)).toBe(false)
  })
})
