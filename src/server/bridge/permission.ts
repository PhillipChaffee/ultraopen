/**
 * Permission rulesets for engine-created child sessions.
 *
 * Layer 1 of the recursion guard, and the PRIMARY mechanism — not one of several equals.
 * `resolveTools` runs the merged ruleset through `Permission.disabled`, which REMOVES a disabled
 * tool from the record handed to the provider, so the model never sees `workflow` at all.
 */

export type PermissionAction = "allow" | "ask" | "deny"

export type PermissionRule = {
  permission: string
  pattern: string
  action: PermissionAction
}

export type Ruleset = PermissionRule[]

/** The tool id this plugin registers. Bare, with no namespace — plugin tools are not prefixed. */
export const WORKFLOW_TOOL = "workflow"

/**
 * The tool opencode injects when a prompt carries `format: {type:"json_schema"}`.
 *
 * Named exactly this by the host, so schema'd children must never have it denied.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput"

/** Tools a workflow child must never reach. */
const CHILD_DENIED_TOOLS = [
  // Recursion: without this a subagent can start its own fan-out.
  WORKFLOW_TOOL,
  // The built-in subagent spawner — a child spawning children escapes our counter and budget.
  "task",
  // The shared task list is per-conversation; a child writing it corrupts the parent's.
  "todowrite",
]

/**
 * Builds the ruleset for a child session.
 *
 * Three rules govern the ORDER, and getting any of them wrong fails silently:
 *
 * 1. Denies must name each tool EXPLICITLY. A blanket `{permission:"*", pattern:"*",
 *    action:"deny"}` also matches the injected `StructuredOutput` tool, stripping it while the
 *    host still sends `toolChoice:"required"` — the model is then forced to call a tool that no
 *    longer exists and the turn dies AFTER being billed, 100% of the time.
 *
 * 2. The pattern must be the literal `"*"`. `Permission.disabled` only treats a tool as hidden
 *    when the last matching rule has exactly that pattern; `"workflow:*"` silently fails to hide.
 *
 * 3. Inherited denies come FIRST. Evaluation is last-match-wins, so our explicit rules must be
 *    able to override anything carried down from the parent — and the StructuredOutput allow,
 *    when present, must come last of all so a parent's blanket deny cannot disarm the turn.
 */
export function childRuleset(options: {
  /** Parent session rules to carry down, mirroring `deriveSubagentSessionPermission`. */
  inherited?: Ruleset | undefined
  /** True when this child will be prompted with a json_schema format. */
  structured?: boolean | undefined
  /** Extra tool ids to deny, from `agent()`'s `disallowedTools`. */
  disallowedTools?: readonly string[] | undefined
}): Ruleset {
  const rules: Ruleset = []

  // Carry down external_directory grants and every deny, so a workflow child is never MORE
  // privileged than a `task` child spawned from the same session.
  for (const rule of options.inherited ?? []) {
    if (rule.action === "deny" || rule.permission === "external_directory") rules.push({ ...rule })
  }

  for (const tool of [...CHILD_DENIED_TOOLS, ...(options.disallowedTools ?? [])]) {
    rules.push({ permission: tool, pattern: "*", action: "deny" })
  }

  // Whether bash was already hidden by what we inherited — captured BEFORE we append the
  // command-pattern denies below, which would otherwise mask the answer.
  const bashAlreadyHidden = isHidden("bash", rules)

  // Bash stays available — workflow agents need it — but a nested `opencode` invocation would get
  // a fresh server, fresh plugin load and fresh tool, escaping the cap, counter, budget and abort
  // signal entirely. Pattern denies do NOT hide the tool (the pattern is not `"*"`), they only
  // block matching commands. This is a backstop; the ULTRAOPEN_ACTIVE env guard is the real fix,
  // because it survives paths this pattern list cannot match (`/usr/local/bin/opencode`, `sh -c`).
  for (const pattern of ["opencode *", "bunx opencode *", "npx opencode *"]) {
    rules.push({ permission: "bash", pattern, action: "deny" })
  }

  // Those narrow patterns would otherwise UN-HIDE bash: `Permission.disabled` reads the LAST rule
  // matching the permission and checks ITS pattern, so appending `pattern:"opencode *"` after an
  // inherited blanket deny makes bash visible again. That would hand a workflow child more
  // privilege than a plain `task` child of the same parent. Re-assert the hide.
  if (bashAlreadyHidden) rules.push({ permission: "bash", pattern: "*", action: "deny" })

  // MUST be last: rulesets are evaluated last-match-wins, so this re-arms StructuredOutput even
  // when the parent contributed a blanket deny.
  if (options.structured) {
    rules.push({ permission: STRUCTURED_OUTPUT_TOOL, pattern: "*", action: "allow" })
  }

  return rules
}

/**
 * Mirrors `Permission.evaluate`: last matching rule wins, defaulting to "ask".
 *
 * Reimplemented rather than imported because `@opencode-ai/core` is `"private": true`. The drift
 * test re-reads opencode's real implementation and fails if the semantics diverge.
 */
export function evaluate(permission: string, pattern: string, ruleset: Ruleset): PermissionAction {
  let action: PermissionAction = "ask"
  for (const rule of ruleset) {
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) action = rule.action
  }
  return action
}

/** opencode collapses these tool ids onto a single permission key before evaluating. */
const EDIT_ALIASES = new Set(["edit", "write", "apply_patch"])
const READ_ALIASES = new Set(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"])

/**
 * True when the tool is hidden from the model entirely, not merely denied.
 *
 * Mirrors `Permission.disabled` exactly, including a subtlety that is easy to get wrong: the
 * search matches on the PERMISSION only, and the pattern is checked on whatever rule that finds.
 * Filtering by `pattern === "*"` *inside* the search instead would report a tool as hidden even
 * when a later narrow rule for the same permission is what actually applies.
 */
export function isHidden(tool: string, ruleset: Ruleset): boolean {
  const permission = EDIT_ALIASES.has(tool) ? "edit" : READ_ALIASES.has(tool) ? "read" : tool
  const last = ruleset.findLast((rule) => wildcardMatch(permission, rule.permission))
  return last?.pattern === "*" && last.action === "deny"
}

/**
 * opencode's wildcard semantics: `*` compiles to `.*` and crosses `/` at any depth, and a trailing
 * `" *"` also matches the bare word (so `"opencode *"` matches `opencode` with no arguments).
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true
  // Detect the trailing " *" on the RAW pattern: the escape pass below does not touch spaces or
  // asterisks, so testing the escaped form would look for characters that are never produced.
  const trailingArgs = pattern.endsWith(" *")
  const core = trailingArgs ? pattern.slice(0, -2) : pattern
  const escaped = core.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll("*", ".*")
  const source = trailingArgs ? `${escaped}( .*)?` : escaped
  return new RegExp(`^${source}$`, "su").test(value)
}
