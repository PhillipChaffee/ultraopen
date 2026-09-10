import { WORKFLOW_TOOL } from "../bridge/permission.js"

/**
 * The mutable config object opencode hands to a plugin's `config` hook.
 *
 * Only the keys this installer touches are modelled. The hook receives the LIVE cached object, and
 * its return value is discarded — mutation is the only channel.
 */
export interface MutableConfig {
  agent?: Record<string, unknown>
  command?: Record<string, unknown>
  permission?: Record<string, unknown> | string
  experimental?: { primary_tools?: string[] } & Record<string, unknown>
  skills?: { paths?: string[] } & Record<string, unknown>
}

/** Description shown in the agent picker. */
const ULTRACODE_DESCRIPTION =
  "Maximum-effort mode: raises reasoning effort and fans work out across parallel subagents by default."

/**
 * Installs the ultracode agent, the /ultracode command, and the permission defaults.
 *
 * MUST be called synchronously, first, with no `await` on the plugin client before it. Any client
 * call from inside the hook re-enters the HTTP server and can materialise `Agent.state` from the
 * not-yet-mutated config, permanently caching an agent list without `ultracode` for that
 * instance's lifetime.
 */
export function installConfig(config: MutableConfig, options: { skillsPath?: string | undefined }): void {
  installAgent(config)
  installCommand(config)
  installPermission(config)
  installPrimaryTools(config)
  installSkillsPath(config, options.skillsPath)
}

/**
 * Registers the `ultracode` primary agent.
 *
 * Deliberately carries NO `prompt`: an agent prompt REPLACES the provider base prompt rather than
 * appending to it, which would lobotomise the agent. The ultracode instruction is appended through
 * the message-transform hook instead.
 *
 * Deliberately carries NO `variant`: an agent-configured variant is only honoured when the
 * resolved model equals the agent's own configured model, so it would silently do nothing for a
 * user on any other model. Effort is set per-call on the prompt body instead.
 *
 * User config is applied BEFORE plugin config hooks run, so spread the user's block last — a
 * straight assignment would clobber their overrides.
 */
function installAgent(config: MutableConfig): void {
  config.agent ??= {}
  const existing = (config.agent["ultracode"] as Record<string, unknown> | undefined) ?? {}
  config.agent["ultracode"] = {
    description: ULTRACODE_DESCRIPTION,
    mode: "primary",
    permission: { [WORKFLOW_TOOL]: "ask" },
    options: { ultracode: true },
    ...existing,
  }
}

/**
 * Registers the `/ultracode` command.
 *
 * `template` MUST be a non-empty string. The command service calls `hints(template)` eagerly while
 * building its state, so a missing or non-string template throws there and takes out EVERY command
 * for the directory — including `/init`.
 *
 * No `agent` field: leaving it undefined means `cmd.agent ?? input.agent` preserves whichever
 * primary agent the user is already on, rather than force-switching them.
 */
function installCommand(config: MutableConfig): void {
  config.command ??= {}
  const existing = (config.command["ultracode"] as Record<string, unknown> | undefined) ?? {}
  config.command["ultracode"] = {
    description: "Turn on ultracode for this session: higher reasoning effort and standing fan-out.",
    template: "$ARGUMENTS",
    ...existing,
  }
}

/**
 * Defaults the `workflow` permission to "ask".
 *
 * Without it the built-in agents' leading `{permission:"*", pattern:"*", action:"allow"}` rule
 * silently auto-approves every fan-out, so the user is never prompted.
 *
 * `config.permission` may legitimately be the STRING "deny" rather than an object, and the
 * top-level permission block has no index signature in the SDK types — writing into it blindly
 * would throw at runtime or shred the user's setting.
 */
function installPermission(config: MutableConfig): void {
  if (typeof config.permission === "string") {return}
  config.permission ??= {}
  config.permission[WORKFLOW_TOOL] ??= "ask"
}

/**
 * Adds `workflow` to `experimental.primary_tools`.
 *
 * Both keys are optional in the schema, so an optional-chained `.push()` is a no-op on the
 * overwhelmingly common default config — the guard would simply not exist. Assign instead.
 *
 * This closes a real hole: the built-in task tool does not check an agent's `mode`, so a model can
 * call `task({subagent_type:"ultracode"})` and run the injected primary agent as a subagent.
 */
function installPrimaryTools(config: MutableConfig): void {
  config.experimental ??= {}
  const current = config.experimental.primary_tools ?? []
  if (!current.includes(WORKFLOW_TOOL)) {config.experimental.primary_tools = [...current, WORKFLOW_TOOL]}
}

/** Publishes the bundled workflow-authoring skill so the model can read the scripting reference. */
function installSkillsPath(config: MutableConfig, skillsPath: string | undefined): void {
  if (!skillsPath) {return}
  config.skills ??= {}
  const current = config.skills.paths ?? []
  if (!current.includes(skillsPath)) {config.skills.paths = [...current, skillsPath]}
}
