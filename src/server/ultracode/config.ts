import { STATUS_TOOL, WORKFLOW_TOOL } from "../bridge/permission.js"

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
export function installConfig(
  config: MutableConfig,
  options: {
    skillsPath?: string | undefined
    /** Saved workflows found on disk; one /workflow-<name> command each. */
    workflowCommands?: readonly { name: string; description: string | undefined }[] | undefined
  },
): void {
  installAgent(config)
  installCommand(config)
  installWorkflowCommands(config, options.workflowCommands ?? [])
  installPermission(config)
  installPrimaryTools(config)
  installSkillsPath(config, options.skillsPath)
}

/**
 * The /workflow-resume command: reruns a past run with its journal replayed.
 *
 * Static rather than per-run: one command covers every run id, and the run
 * directory path is the model's to discover from a launch result or a
 * workflow_status report.
 */
function installResumeCommand(config: MutableConfig): void {
  config.command ??= {}
  const existing = (config.command["workflow-resume"] as Record<string, unknown> | undefined) ?? {}
  config.command["workflow-resume"] = {
    description: "Resume a previous workflow run from its journal.",
    template:
      "Resume a workflow run. $ARGUMENTS is the run id (wf_…) from a launch result or a workflow_status report. " +
      "Call the workflow tool with resumeFromRunId set to that id and scriptPath set to the script.js inside its run directory " +
      "(the launch result and workflow_status both report the directory; if the run id is missing, list the most recent wf_* " +
      "directories under the opencode data directory's tool-output/ultraopen and ask which one to resume). " +
      "Then poll workflow_status(runId, { wait: 120 }) until it settles and reply with the final value or the failure.",
    ...existing,
  }
}

/**
 * Registers one slash command per saved workflow, following the installCommand pattern.
 *
 * The template MUST be a non-empty string and MUST keep `$ARGUMENTS`: the
 * command service calls the hint builder eagerly, and a missing template takes
 * out every command in the directory, including `/init`. The model is told to
 * wrap the named form in a tiny script — the named form is a GLOBAL inside the
 * sandbox, not a tool argument — and to poll workflow_status until the run
 * settles, so the launch result's run id is not mistaken for an outcome.
 */
function installWorkflowCommands(
  config: MutableConfig,
  saved: readonly { name: string; description: string | undefined }[],
): void {
  installResumeCommand(config)

  // One slash command per saved workflow. The template MUST be a non-empty
  // string keeping $ARGUMENTS (the command service builds hints eagerly; a
  // missing template takes out every command in the directory, /init included).

  for (const workflow of saved) {
    // Command ids are bare keys; a name with anything but letters, digits, `_`
    // and `-` would make an unusable (or hostile) command id.
    if (!/^[\w-]+$/u.test(workflow.name)) {continue}
    config.command ??= {}
    const id = `workflow-${workflow.name}`,
     existing = (config.command[id] as Record<string, unknown> | undefined) ?? {}
    config.command[id] = {
      description: workflow.description ?? `Run the saved workflow "${workflow.name}".`,
      template:
        `Call the workflow tool with a script that is exactly:\n` +
        `export const meta = { name: 'saved-${workflow.name}', description: 'Saved workflow ${workflow.name}' }\n` +
        `await workflow('${workflow.name}')\n` +
        `Pass the user's request as the tool's args when it names inputs for the workflow ($ARGUMENTS). ` +
        `The tool returns a run id, not the outcome: poll workflow_status(runId, { wait: 120 }) until it settles and reply with the final value or the failure.`,
      ...existing,
    }
  }
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
    permission: { [WORKFLOW_TOOL]: "ask", [STATUS_TOOL]: "allow" },
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
  // Read-only: polls the run directory on disk. Prompting for it would train
  // the model to avoid polling, which is how a background run gets lost.
  config.permission[STATUS_TOOL] ??= "allow"
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
  const next = [...current]
  for (const tool of [WORKFLOW_TOOL, STATUS_TOOL]) {
    if (!next.includes(tool)) {next.push(tool)}
  }
  config.experimental.primary_tools = next
}

/** Publishes the bundled workflow-authoring skill so the model can read the scripting reference. */
function installSkillsPath(config: MutableConfig, skillsPath: string | undefined): void {
  if (!skillsPath) {return}
  config.skills ??= {}
  const current = config.skills.paths ?? []
  if (!current.includes(skillsPath)) {config.skills.paths = [...current, skillsPath]}
}
