import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { HostPort } from "./port.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import type { UltraopenOptions } from "../options.js"
import { evaluate, STATUS_TOOL, STRUCTURED_OUTPUT_TOOL, WORKFLOW_TOOL } from "../bridge/permission.js"
import { normalizeStructuredSchema, validate } from "../bridge/validate.js"
import { mintMessageID } from "../bridge/spawn.js"
import { executeStatus } from "../tool/status.js"
import type { StatusArgs } from "../tool/status.js"
import type { WorkflowArgs } from "../tool/workflow.js"
import { launchWorkflow } from "../tool/launch.js"
import type { AssertLaunchPermission, WorkflowCommandState } from "../tool/launch.js"
import {
  blockingDescription,
  description,
  longLivedDescription,
  statusDescription,
  withSizeAdvice,
} from "../tool/description.js"
import {
  renderStatus,
  statusArgsSchema,
  workflowArgsSchema,
} from "../tool/render.js"
import type { PermissionRule } from "../bridge/permission.js"

/**
 * The V2 transforms that build ultraopen's model-facing surfaces.
 *
 * V2 runs transforms in phases: built-in defaults, then plugin transforms, then user
 * `opencode.json` overrides and saved `Allow always` policies. Registering here is therefore
 * additive by contract — a user's own agent block or policy replays AFTER this and wins.
 */

const ULTRACODE_DESCRIPTION =
  "Maximum-effort mode: raises reasoning effort and fans work out across parallel subagents by default."

export const STRUCTURED_OUTPUT_DESCRIPTION =
  "Deliver your final answer as a structured value. Call this exactly once, with a value matching the required schema."

/** The bundled workflow-authoring reference, read from disk before the synchronous transform. */
export interface BundledSkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly path: string
  readonly content: string
}

/** Everything `registerTransforms` needs from the composition root. */
export interface TransformDeps {
  /** The reloadable host proxy the launch path and status tool drive. */
  readonly host: HostPort
  readonly project: ProjectRuntime
  readonly coordinator: RuntimeCoordinator
  readonly options: UltraopenOptions
  readonly bootId: string
  readonly longLived: boolean
  /** Live command definitions; the launch path may replace `entries` and call `reload`. */
  readonly commandState: WorkflowCommandState
  readonly skill: BundledSkill | undefined
  readonly assertPermission: AssertLaunchPermission
}

/**
 * Reads the bundled skill from the package's `skills/` directory.
 *
 * Two candidates cover both layouts this module runs in: the source tree
 * (`src/server/host` -> three levels up) and the bundled `dist/server.js` (one level up). A
 * missing file degrades to no skill rather than failing plugin setup.
 */
export async function loadBundledSkill(
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
  dirname: string = import.meta.dirname,
): Promise<BundledSkill | undefined> {
  const relative = ["skills", "workflow-authoring", "SKILL.md"]
  const candidates = [
    join(dirname, "..", "..", "..", ...relative),
    join(dirname, "..", ...relative),
  ]
  for (const path of candidates) {
    try {
      const content = await read(path)
      return {
        id: "workflow-authoring",
        name: "workflow-authoring",
        description: "Reference for authoring ultraopen workflow scripts: meta, agent(), combinators, schemas and resume.",
        path,
        content,
      }
    } catch {
      // Try the other layout.
    }
  }
  return undefined
}

/** Registers the agent, command, skill and tool transforms. */
export async function registerTransforms(ctx: Plugin.Context, deps: TransformDeps): Promise<void> {
  await ctx.agent.transform((editor) => {
    editor.update("ultracode", (agent) => {
      agent.description = ULTRACODE_DESCRIPTION
      agent.mode = "primary"
      // An agent prompt REPLACES the provider base prompt; the plugin never sets one.
      delete agent.system
      ensureRule(agent.permissions, WORKFLOW_TOOL, "ask")
      ensureRule(agent.permissions, STATUS_TOOL, "allow")
    })

    for (const agent of editor.list()) {
      if (agent.mode === "subagent") {
        ensureRule(agent.permissions, WORKFLOW_TOOL, "deny")
        ensureRule(agent.permissions, STATUS_TOOL, "deny")
        continue
      }
      // A user policy that already denies the tool is not softened back to ask.
      if (evaluate(WORKFLOW_TOOL, "*", agent.permissions) !== "deny") {
        ensureRule(agent.permissions, WORKFLOW_TOOL, "ask")
      }
      if (evaluate(STATUS_TOOL, "*", agent.permissions) !== "deny") {
        ensureRule(agent.permissions, STATUS_TOOL, "allow")
      }
    }
  })

  await ctx.command.transform((editor) => {
    editor.add({
      name: "ultracode",
      description: "Turn on ultracode for this session: higher reasoning effort and standing fan-out.",
      execute: async (input) => {
        const text = input.prompt.text.trim(),
         lowered = text.toLowerCase()
        if (lowered === "off") {
          deps.project.mode.disable(input.sessionID)
          return
        }
        deps.project.mode.enable(input.sessionID, "command")
        if (text !== "") {
          await prompt(ctx, input.sessionID, text, input.delivery)
        }
      },
    })

    editor.add({
      name: "workflow-resume",
      description: "Resume a previous workflow run from its journal.",
      execute: async (input) => {
        const runId = input.prompt.text.trim()
        await prompt(
          ctx,
          input.sessionID,
          `Resume a workflow run. ${
            runId === ""
              ? "The run id (wf_…) comes from a launch result or a workflow_status report; ask which run to resume if it is missing."
              : `The run id is ${runId}.`
          } Call the workflow tool with resumeFromRunId set to that id and scriptPath set to the script.js inside its run directory (a launch result and workflow_status both report the directory). Then poll workflow_status(runId, { wait: 120 }) until it settles and reply with the final value or the failure.`,
          input.delivery,
        )
      },
    })

    for (const workflow of deps.commandState.entries) {
      // Command ids are bare keys; anything else would make an unusable (or hostile) command id.
      if (!/^[\w-]+$/u.test(workflow.name)) {continue}
      editor.add({
        name: `workflow-${workflow.name}`,
        description: workflow.description ?? `Run the saved workflow "${workflow.name}".`,
        execute: async (input) => {
          await prompt(
            ctx,
            input.sessionID,
            `Call the workflow tool with a script that is exactly:\n` +
              `export const meta = { name: 'saved-${workflow.name}', description: 'Saved workflow ${workflow.name}' }\n` +
              `await workflow('${workflow.name}')\n` +
              `Pass the user's request as the tool's args when it names inputs for the workflow (${input.prompt.text}). ` +
              `The tool returns a run id, not the outcome: poll workflow_status(runId, { wait: 120 }) until it settles and reply with the final value or the failure.`,
            input.delivery,
          )
        },
      })
    }
  })

  if (deps.skill !== undefined) {
    // Read before this transform, and keep `path` ending in `SKILL.md` so OpenCode discovers the
    // skill's sibling files relative to it.
    const { skill } = deps
    await ctx.skill.transform((editor) => {
      // V2 brands the id, name and path as its own string types. Branding exactly those three
      // fields keeps `satisfies` checking every other field against the editor's real input type,
      // where casting the whole object would silently accept a mistyped `content` or `description`.
      editor.add({
        id: skill.id as Parameters<typeof editor.add>[0]["id"],
        name: skill.name as Parameters<typeof editor.add>[0]["name"],
        description: skill.description,
        path: skill.path as Parameters<typeof editor.add>[0]["path"],
        content: skill.content,
      } satisfies Parameters<typeof editor.add>[0])
    })
  }

  // A nested `opencode` process gets a fresh plugin load and tool, escaping this process's
  // concurrency cap, agent counter, budget and abort signal. Refusing to register is the one
  // guard that survives every shell path a permission pattern cannot match.
  if (process.env["ULTRAOPEN_ACTIVE"] === "1") {return}

  await ctx.tool.transform((editor) => {
    editor.add({
      name: WORKFLOW_TOOL,
      description: toolDescription(deps.options, deps.longLived),
      input: workflowArgsSchema(),
      options: { codemode: false },
      execute: async (input, context) => ({
        content: await launchWorkflow(input as WorkflowArgs, launchContextOf(context), {
          host: deps.host,
          project: deps.project,
          coordinator: deps.coordinator,
          options: deps.options,
          bootId: deps.bootId,
          longLived: deps.longLived,
          commandState: deps.commandState,
          assertPermission: deps.assertPermission,
        }),
      }),
    })

    editor.add({
      name: STATUS_TOOL,
      description: statusDescription,
      input: statusArgsSchema(),
      options: { codemode: false },
      execute: async (input, context) => {
        try {
          const report = await executeStatus(input as StatusArgs, {
            bootId: deps.coordinator.processBootId,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          return { content: renderStatus(report) }
        } catch (error) {
          // An unknown or malformed run id is a clear error for the model, never a crash.
          return { content: error instanceof Error ? error.message : String(error) }
        }
      },
    })

    editor.add({
      name: STRUCTURED_OUTPUT_TOOL,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      // The per-child schema replaces this permissive base in `hook("context")`.
      input: { type: "object", additionalProperties: true },
      options: { codemode: false },
      execute: async (input, context) => await captureStructured(deps.coordinator, input, context),
    })
  })
}

/** The `workflow_status` tool's description is a constant; the launch one varies by contract. */
function toolDescription(options: UltraopenOptions, longLived: boolean): string {
  if (options.runMode === "blocking") {return blockingDescription}
  const base = longLived ? longLivedDescription : description
  if (options.sizeGuideline === undefined) {return base}
  return withSizeAdvice(base, options.sizeGuideline)
}

/**
 * Adds a rule unless the identical `(action, resource, effect)` triple is already present.
 *
 * Appending blindly would grow the agent's ruleset on every transform reload.
 */
function ensureRule(rules: PermissionRule[], action: string, effect: "allow" | "ask" | "deny"): void {
  if (rules.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === effect)) {return}
  rules.push({ action, resource: "*", effect })
}

/** The launch's tool-execute context fields, narrowed from V2's full `ToolContext`. */
function launchContextOf(context: ToolContext): Parameters<typeof launchWorkflow>[1] {
  return {
    sessionID: context.sessionID,
    ...(context.agent === undefined ? {} : { agent: context.agent }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  }
}

/**
 * The `StructuredOutput` executor: validate in-loop, capture on success, throw for self-repair.
 *
 * Throwing `Tool.Error` is deliberate: it returns the validation failure to the model inside the
 * SAME turn so it can repair its call, instead of ending the turn and burning an attempt.
 */
function captureStructured(
  coordinator: RuntimeCoordinator,
  input: unknown,
  context: ToolContext,
): { content: string; metadata: { structured: unknown } } {
  const child = coordinator.childOf(context.sessionID)
  if (child === undefined) {
    throw new ToolError({
      message: "StructuredOutput is only available inside an ultraopen workflow child session.",
    })
  }
  const schema = child.schema
  if (schema === undefined) {
    throw new ToolError({
      message: "This session has no requested structured schema; reply normally instead of calling StructuredOutput.",
    })
  }

  const verdict = validate(input, normalizeStructuredSchema(schema))
  if (!verdict.valid) {
    child.lastValidationErrors = verdict.errors
    throw new ToolError({
      message: `StructuredOutput did not match the required schema: ${verdict.errors.slice(0, 4).join("; ")}`,
    })
  }

  child.captured = { value: structuredClone(input), attempt: child.currentAttempt }
  return {
    content: "Structured output captured. Your final value has been delivered; do not call this tool again.",
    metadata: { structured: input },
  }
}

/** Prompts a session from a command, minting the `msg_`-prefixed id V2 requires. */
async function prompt(
  ctx: Plugin.Context,
  sessionID: string,
  text: string,
  delivery: "steer" | "queue",
): Promise<void> {
  await ctx.session.prompt({
    sessionID,
    id: mintMessageID(),
    text,
    delivery,
  })
}
