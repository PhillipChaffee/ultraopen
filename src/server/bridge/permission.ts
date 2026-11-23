/**
 * Permission rulesets and live ancestor policy for engine-created child sessions.
 *
 * Rules use OpenCode V2's `{ action, resource, effect }` shape. Static child containment is the
 * PRIMARY recursion guard — `resolveTools` runs the merged ruleset through the host's disabled
 * filter, which REMOVES a fully denied tool from the record handed to the provider, so the model
 * never sees `workflow` at all.
 *
 * The live ancestor walk (`evaluateAncestors`) is the #149 invariant: a child is never more
 * privileged than the chat that started it, no matter which agent the parent switches to.
 */
import type { HostAgentInfo, HostPermissionRule, HostPort, HostSessionInfo } from "../host/port.js"

export type PermissionEffect = "allow" | "ask" | "deny"

/** One stored rule. The last matching rule wins, exactly as on the host. */
export type PermissionRule = HostPermissionRule

export type Ruleset = readonly PermissionRule[]

/** The tool id this plugin registers. Bare, with no namespace — plugin tools are not prefixed. */
export const WORKFLOW_TOOL = "workflow"

/** The read-only companion tool. Same registration rules as WORKFLOW_TOOL. */
export const STATUS_TOOL = "workflow_status"

/**
 * The tool opencode injects when a prompt carries `format: {type:"json_schema"}`.
 *
 * Named exactly this by the host, so schema'd children must never have it denied.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput"

/** V1 tool ids still arrive from inherited rules and `disallowedTools`; V2 collapsed them. */
const ACTION_ALIASES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  apply_patch: "edit",
  patch: "edit",
  list_mcp_resources: "opencode_list_mcp_resources",
  read_mcp_resource: "opencode_read_mcp_resource",
}

/** Maps a tool id onto the V2 action it is evaluated as. */
export function normalizePermissionAction(tool: string): string {
  return ACTION_ALIASES[tool] ?? tool
}

const REGEX_SPECIAL = new Set([".", "+", "^", "$", "{", "}", "(", ")", "[", "]", "|", "\\"])

/** Escapes one literal character, leaving the wildcard pass to translate `*` and `?`. */
function literalSource(character: string): string {
  return REGEX_SPECIAL.has(character) ? `\\${character}` : character
}

const GLOB_WILDCARDS: Readonly<Record<string, string>> = { "*": ".*", "?": "." }

function globSource(pattern: string): string {
  let source = ""
  for (const character of pattern) {
    source += GLOB_WILDCARDS[character] ?? literalSource(character)
  }
  return source
}

/**
 * V2 wildcard semantics: `\` normalizes to `/`, `*` compiles to `.*` and crosses `/`, `?` matches
 * one character, and a trailing `" *"` also matches the bare word (`"opencode *"` matches
 * `opencode`). Windows matching is case-insensitive; everywhere else it is exact.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") {return true}
  const normalizedPattern = pattern.replaceAll("\\", "/"),
   trailingArgs = normalizedPattern.endsWith(" *"),
   core = trailingArgs ? normalizedPattern.slice(0, -2) : normalizedPattern,
   source = `${globSource(core)}${trailingArgs ? "( .*)?" : ""}`,
   flags = process.platform === "win32" ? "isu" : "su"
  return new RegExp(`^${source}$`, flags).test(value.replaceAll("\\", "/"))
}

/**
 * Mirrors `Permission.evaluate`: last matching rule wins, defaulting to "ask".
 *
 * Reimplemented rather than imported because `@opencode-ai/core` is `"private": true`. The drift
 * test re-reads opencode's real implementation and fails if the semantics diverge.
 */
export function evaluate(action: string, resource: string, ruleset: Ruleset): PermissionEffect {
  const normalized = normalizePermissionAction(action)
  let effect: PermissionEffect = "ask"
  for (const rule of ruleset) {
    if (wildcardMatch(normalized, normalizePermissionAction(rule.action)) && wildcardMatch(resource, rule.resource)) {
      effect = rule.effect
    }
  }
  return effect
}

/**
 * True when the tool is hidden from the model entirely, not merely denied.
 *
 * Mirrors V2 `whollyDisabled` exactly: the last rule matching the ACTION must carry the literal
 * `"*"` resource and deny. A narrow resource (for example `"opencode *"`) blocks matching commands
 * but leaves the tool visible.
 */
export function isHidden(tool: string, ruleset: Ruleset): boolean {
  const action = normalizePermissionAction(tool)
  const last = ruleset.findLast((rule) => wildcardMatch(action, normalizePermissionAction(rule.action)))
  return last?.resource === "*" && last.effect === "deny"
}

/** Tools a workflow child must never reach. */
export const CHILD_DENIED_TOOLS: ReadonlySet<string> = new Set([
  // Recursion: without this a subagent can start its own fan-out.
  WORKFLOW_TOOL,
  // Read-only, but children have no business polling the parent's run.
  STATUS_TOOL,
  // The built-in subagent spawner — a child spawning children escapes our counter and budget.
  "subagent",
  // The shared task list is per-conversation; a child writing it corrupts the parent's.
  "todowrite",
])

/** Command resources that would start a second OpenCode process. */
const OPENCODE_COMMANDS = ["opencode *", "bunx opencode *", "npx opencode *", "*/opencode *"]

/**
 * Builds the ruleset for a child session.
 *
 * Three rules govern the ORDER, and getting any of them wrong fails silently:
 *
 * 1. Denies name each tool EXPLICITLY. A blanket `{action:"*", resource:"*", effect:"deny"}` also
 *    matches the injected `StructuredOutput` tool, stripping it while the host still sends
 *    `toolChoice:"required"` — the model is forced to call a tool that no longer exists.
 *
 * 2. A hidden tool needs the literal `"*"` resource. `Permission.disabled` only treats a tool as
 *    hidden when the last matching rule has exactly that resource; `"workflow:*"` silently fails.
 *
 * 3. Inherited rules come FIRST. Evaluation is last-match-wins, so our explicit rules must be able
 *    to override anything carried down from the parent — and the StructuredOutput allow, when
 *    present, must come last of all so a parent's blanket deny cannot disarm the turn.
 */
export function childRuleset(options: {
  /** Parent session rules to carry down. Only denies (and external_directory) are inherited. */
  inherited?: Ruleset | undefined
  /** True when this child will be prompted with a json_schema format. */
  structured?: boolean | undefined
  /** Extra tool ids to deny, from `agent()`'s `disallowedTools`. */
  disallowedTools?: readonly string[] | undefined
  /** The canonical checkout a worktree child must not edit. */
  blockDirectory?: string | undefined
}): PermissionRule[] {
  const rules: PermissionRule[] = []

  // Carry every deny down, plus external_directory policy at any effect. V2 defaults
  // external_directory to allow, but an inherited ask is still stricter and must survive so a
  // workflow child is never MORE privileged than a `task` child of the same parent.
  for (const rule of options.inherited ?? []) {
    if (rule.effect === "deny" || normalizePermissionAction(rule.action) === "external_directory") {
      rules.push({ ...rule })
    }
  }

  for (const tool of CHILD_DENIED_TOOLS) {rules.push({ action: tool, resource: "*", effect: "deny" })}

  // Captured BEFORE the command resources below, which would otherwise mask the answer.
  const shellAlreadyHidden = isHidden("shell", rules)

  // Shell stays available — workflow agents need it — but a nested `opencode` invocation would get
  // a fresh server, plugin load and tool, escaping the cap, counter, budget and abort signal.
  // Resource denies do NOT hide the tool; they only block matching commands. The ULTRAOPEN_ACTIVE
  // env guard remains the real fix for paths this list cannot match.
  for (const resource of OPENCODE_COMMANDS) {rules.push({ action: "shell", resource, effect: "deny" })}

  // Those narrow resources would otherwise UN-HIDE shell: the disabled filter reads the LAST rule
  // matching the action and checks ITS resource, so appending `opencode *` after an inherited
  // blanket deny makes shell visible again. Re-assert the hide.
  if (shellAlreadyHidden) {rules.push({ action: "shell", resource: "*", effect: "deny" })}

  for (const tool of options.disallowedTools ?? []) {
    rules.push({ action: normalizePermissionAction(tool), resource: "*", effect: "deny" })
  }

  // Worktree isolation: the child may edit its own checkout, never the original one, even if an
  // inherited allow or a user's `Allow always` covers the original path.
  if (options.blockDirectory !== undefined) {
    rules.push({ action: "edit", resource: `${options.blockDirectory}/**`, effect: "deny" })
  }

  // MUST be last: rulesets evaluate last-match-wins, so this re-arms StructuredOutput even when
  // the parent contributed a blanket deny.
  if (options.structured === true) {rules.push({ action: STRUCTURED_OUTPUT_TOOL, resource: "*", effect: "allow" })}

  return rules
}

interface ShellToken {
  readonly kind: "word" | "operator"
  readonly value: string
}

/**
 * Splits a shell command into words and control operators, honoring quotes and escapes.
 *
 * Only command POSITIONS matter: `rg opencode src/` mentions the binary but never executes it, so
 * scanning raw substrings would block ordinary work.
 */
function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let word = "",
   started = false,
   quote: "\"" | "'" | undefined
  const pushWord = (): void => {
    if (started) {
      tokens.push({ kind: "word", value: word })
      word = ""
      started = false
    }
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command.charAt(index)
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      } else if (character === "\\" && quote === "\"") {
        const escaped = command.charAt(index + 1)
        if (escaped !== "") {word += escaped; index += 1}
      } else {
        word += character
      }
      started = true
      continue
    }
    if (character === "'" || character === "\"") {
      quote = character
      started = true
    } else if (character === "\\") {
      const escaped = command.charAt(index + 1)
      if (escaped !== "") {word += escaped; index += 1}
      started = true
    } else if (";&|()\n".includes(character)) {
      pushWord()
      const next = command.charAt(index + 1)
      if ((character === "&" || character === "|") && next === character) {
        tokens.push({ kind: "operator", value: `${character}${character}` })
        index += 1
      } else {
        tokens.push({ kind: "operator", value: character })
      }
    } else if (/\s/u.test(character)) {
      pushWord()
    } else {
      word += character
      started = true
    }
  }
  pushWord()
  return tokens
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const RUNNERS = new Set(["npx", "bunx"])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u
const MAX_RECURSION = 4

/** Last path component, normalized for Windows separators. */
function commandName(word: string): string {
  const normalized = word.replaceAll("\\", "/"),
   slash = normalized.lastIndexOf("/")
  return (slash === -1 ? normalized : normalized.slice(slash + 1)).toLowerCase()
}

/** The command string passed to a shell's `-c` (including clustered short options like `-lc`). */
function shellCommandArgument(words: readonly string[]): string | undefined {
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index] ?? ""
    if (word === "-c" || (word.startsWith("-") && !word.startsWith("--") && word.includes("c"))) {
      return words[index + 1]
    }
  }
  return undefined
}

function segmentInvokesOpencode(words: readonly string[], depth: number): boolean {
  let index = 0
  while (index < words.length) {
    const word = words[index] ?? ""
    if (ENV_ASSIGNMENT.test(word)) {
      index += 1
      continue
    }
    if (word === "env") {
      index += 1
      while (index < words.length) {
        const option = words[index] ?? ""
        if (!ENV_ASSIGNMENT.test(option) && !option.startsWith("-")) {break}
        index += 1
      }
      continue
    }
    break
  }

  const command = words[index]
  if (command === undefined) {return false}
  const name = commandName(command)
  if (name === "opencode") {return true}

  if (SHELLS.has(name)) {
    const argument = shellCommandArgument(words.slice(index))
    return argument !== undefined && invokesOpencode(argument, depth + 1)
  }

  if (RUNNERS.has(name)) {
    let target = index + 1
    while (target < words.length && (words[target] ?? "").startsWith("-")) {target += 1}
    const candidate = words[target]
    if (candidate === undefined) {return false}
    const targetName = commandName(candidate)
    if (targetName === "opencode") {return true}
    if (SHELLS.has(targetName)) {
      const argument = shellCommandArgument(words.slice(target))
      return argument !== undefined && invokesOpencode(argument, depth + 1)
    }
  }

  return false
}

function invokesOpencode(command: string, depth: number): boolean {
  if (depth > MAX_RECURSION) {return false}
  let words: string[] = []
  for (const token of tokenizeShell(command)) {
    if (token.kind === "operator") {
      if (segmentInvokesOpencode(words, depth)) {return true}
      words = []
    } else {
      words.push(token.value)
    }
  }
  return segmentInvokesOpencode(words, depth)
}

/**
 * True when the command executes the `opencode` binary in any command position.
 *
 * Catches bare names, absolute and relative paths, `env` assignments, `bunx`/`npx`, and shell
 * `-c` wrappers. It deliberately ignores `opencode` appearing as an argument (`rg opencode src/`),
 * and cannot inspect a script file handed to `sh script.sh` — the env-tagging layers cover that.
 */
export function shellInvokesOpencode(command: string): boolean {
  return invokesOpencode(command, 0)
}

/** The live host surface the ancestor walk needs, kept structural so tests need no adapter. */
export interface AncestorPolicyLookup {
  readonly getSession: (sessionID: string) => Promise<HostSessionInfo | undefined>
  readonly getAgent: (agentID: string, directory?: string) => Promise<HostAgentInfo | undefined>
  readonly defaultAgentID: (directory?: string) => Promise<string | undefined>
}

export interface AncestorEvaluationInput {
  readonly childSessionID: string; readonly parentSessionID: string
  readonly action: string; readonly resources: readonly string[]
  readonly currentEffect: PermissionEffect; readonly childConfiguredEffect?: PermissionEffect | undefined
  readonly lookup: AncestorPolicyLookup
}

export interface AncestorEvaluation { readonly effect: PermissionEffect; readonly message?: string | undefined }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The structural `metadata.ultraopen` record an engine-created child carries. */
export function ultraopenMetadataOf(metadata: unknown): Record<string, unknown> | undefined {
  if (!isRecord(metadata)) {return undefined}
  const ultraopen = metadata["ultraopen"]
  return isRecord(ultraopen) ? ultraopen : undefined
}

/**
 * The next link up: ultraopen metadata first (V2 child sessions are unparented), then the native
 * parentID for ancestors created by opencode itself.
 */
function ancestorParentID(session: HostSessionInfo): string | undefined {
  const parentID = ultraopenMetadataOf(session.metadata)?.["parentSessionID"]
  return typeof parentID === "string" && parentID !== "" ? parentID : session.parentID
}

/**
 * The host-backed ancestor lookup, including the default-agent fallback a session row may omit.
 *
 * Host transport failures resolve to "nothing known" — `undefined`, or `[]` for the agent list —
 * so a dropped connection fails the walk CLOSED (deny), never open.
 */
export function createAncestorLookup(
  host: Pick<HostPort, "getSession" | "getAgent" | "listAgents">,
): AncestorPolicyLookup {
  return {
    getSession: async (sessionID) => {
      try {
        return await host.getSession(sessionID)
      } catch {
        return undefined
      }
    },
    getAgent: async (agentID, directory) => {
      try {
        return await host.getAgent(agentID, directory)
      } catch {
        return undefined
      }
    },
    defaultAgentID: async (directory) => {
      let agents: readonly HostAgentInfo[]
      try {
        agents = await host.listAgents(directory)
      } catch {
        agents = []
      }
      return (
        agents.find((agent) => agent.id === "build")?.id ??
        agents.find((agent) => agent.mode === "primary" && !agent.hidden)?.id
      )
    },
  }
}

/** deny > ask > allow. The intersection of every constraint in the chain. */
function combine(left: PermissionEffect, right: PermissionEffect): PermissionEffect {
  if (left === "deny" || right === "deny") {return "deny"}
  if (left === "ask" || right === "ask") {return "ask"}
  return "allow"
}

/**
 * One ruleset's configured effect for an action across every requested resource.
 *
 * `deny > ask > allow`: every resource must be allowed for the result to be `allow`, so a narrower
 * deny cannot be hidden by a broader allow. A ruleset with no matching rule reads `ask`, exactly as
 * the host's own default does.
 */
export function configuredEffect(
  action: string,
  resources: readonly string[],
  ruleset: Ruleset,
): PermissionEffect {
  let effect: PermissionEffect = "allow"
  for (const resource of resources) {effect = combine(effect, evaluate(action, resource, ruleset))}
  return effect
}

type SessionResolution =
  | { readonly ok: true; readonly ruleset: Ruleset; readonly parentID: string | undefined }
  | { readonly ok: false; readonly message: string }

/** Loads one session and the agent that is live for it right now. */
export async function resolveSessionRuleset(
  sessionID: string,
  lookup: AncestorPolicyLookup,
): Promise<SessionResolution> {
  const session = await lookup.getSession(sessionID)
  if (session === undefined) {
    return { ok: false, message: `ancestor session ${sessionID} could not be resolved` }
  }
  const agentID = session.agent ?? (await lookup.defaultAgentID(session.directory))
  if (agentID === undefined) {
    return { ok: false, message: `no agent could be resolved for ancestor session ${sessionID}` }
  }
  const agent = await lookup.getAgent(agentID, session.directory)
  if (agent === undefined) {
    return { ok: false, message: `ancestor agent ${agentID} for session ${sessionID} could not be resolved` }
  }
  // Session rules are applied after agent rules on the host, so they are the tighter later word.
  const ruleset: Ruleset = [...agent.permissions, ...(session.permissions ?? [])]
  return { ok: true, ruleset, parentID: ancestorParentID(session) }
}

type ChainResolution =
  | { readonly ok: true; readonly rulesets: readonly Ruleset[] }
  | { readonly ok: false; readonly message: string }

/**
 * Resolves the live ancestor chain ONCE, nearest first.
 *
 * Every caller that needs several tools or several pending requests shares one walk rather than
 * re-fetching the same ancestor per item. Any unresolvable session or agent — and any corrupt
 * cycle — fails CLOSED, never open (#149 invariants 6-8).
 */
export async function resolveAncestorChain(
  childSessionID: string,
  parentSessionID: string,
  lookup: AncestorPolicyLookup,
): Promise<ChainResolution> {
  const visited = new Set<string>([childSessionID]),
   rulesets: Ruleset[] = []
  let currentID: string | undefined = parentSessionID

  while (currentID !== undefined) {
    if (visited.has(currentID)) {
      return { ok: false, message: `permission ancestor cycle detected at session ${currentID}` }
    }
    visited.add(currentID)
    const resolved = await resolveSessionRuleset(currentID, lookup)
    if (!resolved.ok) {return { ok: false, message: resolved.message }}
    rulesets.push(resolved.ruleset)
    currentID = resolved.parentID
  }

  return { ok: true, rulesets }
}

export interface ResolvedAncestorInput {
  readonly action: string
  readonly resources: readonly string[]
  readonly currentEffect: PermissionEffect
  readonly childConfiguredEffect?: PermissionEffect | undefined
}

/**
 * Intersects an already-resolved ancestor chain with the child's own effect.
 *
 * Core's `Allow always` is preserved only when the child's own rule is `ask` and the host already
 * resolved the current request to `allow`; otherwise an ancestor ask escalates a child allow.
 */
export function evaluateResolvedAncestors(
  rulesets: readonly Ruleset[],
  input: ResolvedAncestorInput,
): AncestorEvaluation {
  let ancestorEffect: PermissionEffect = "allow"
  for (const ruleset of rulesets) {
    ancestorEffect = combine(ancestorEffect, configuredEffect(input.action, input.resources, ruleset))
    if (ancestorEffect === "deny") {return { effect: "deny" }}
  }

  if (input.currentEffect === "deny") {return { effect: "deny" }}
  if (ancestorEffect === "allow") {return { effect: input.currentEffect }}
  // The user already answered this exact ask with "Allow always"; the ancestor only asks too.
  if (input.childConfiguredEffect === "ask" && input.currentEffect === "allow") {
    return { effect: "allow" }
  }
  return { effect: "ask" }
}

/** True when ANY ancestor in the chain hides the tool behind a blanket deny. */
export function isHiddenByAncestors(tool: string, rulesets: readonly Ruleset[]): boolean {
  return rulesets.some((ruleset) => isHidden(tool, ruleset))
}

/**
 * Walks the live ancestor chain and intersects its effective permission with the child's.
 *
 * Re-evaluated on every child action, so a parent switching from `plan` to `build` tightens or
 * relaxes the child immediately.
 */
export async function evaluateAncestors(input: AncestorEvaluationInput): Promise<AncestorEvaluation> {
  const chain = await resolveAncestorChain(input.childSessionID, input.parentSessionID, input.lookup)
  if (!chain.ok) {return { effect: "deny", message: chain.message }}
  return evaluateResolvedAncestors(chain.rulesets, input)
}
