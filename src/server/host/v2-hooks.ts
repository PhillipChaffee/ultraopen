import type { Plugin } from "@opencode/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission"
import type { SessionContext, SessionModelResolve, SessionPrompt } from "@opencode/plugin/promise/session"
import type { ShellCreateBefore } from "@opencode/plugin/promise/shell"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { HostPort } from "./port.js"
import type { AncestorPolicyLookup, PermissionEffect } from "../bridge/permission.js"
import {
  CHILD_DENIED_TOOLS,
  configuredEffect,
  createAncestorLookup,
  evaluateResolvedAncestors,
  isHiddenByAncestors,
  resolveAncestorChain,
  resolveSessionRuleset,
  shellInvokesOpencode,
  STATUS_TOOL,
  STRUCTURED_OUTPUT_TOOL,
  ultraopenMetadataOf,
  WORKFLOW_TOOL,
} from "../bridge/permission.js"
import { normalizeStructuredSchema } from "../bridge/validate.js"
import type { LocationActivation, ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import { onSessionPrompt, onSessionContext, onModelResolve, resolveUltracodeVariant } from "../ultracode/hooks.js"
import { onV2Event } from "../runtime/events.js"
import { STRUCTURED_OUTPUT_DESCRIPTION } from "./v2-transforms.js"

/**
 * The V2 session, permission, tool and shell hooks plus the resilient event loop.
 *
 * Every hook is scoped: engine-owned children get the containment layers, and an ordinary user
 * session is left alone except for the ephemeral ultracode reminders. The permission hook fails
 * CLOSED for anything this engine owns — a live ancestor walk that cannot resolve its chain denies,
 * exactly as `#149` requires.
 */

/** How long a shell token authorized by `execute.before` stays valid for its creation hook. */
const SHELL_TOKEN_TTL_MS = 30_000

/** The host and coordinator pair every hook path and the event stream read. */
export interface RuntimeDeps {
  readonly host: HostPort
  readonly coordinator: RuntimeCoordinator
}

/** Everything `registerHooks` needs from the composition root. */
export interface HookDeps extends RuntimeDeps {
  readonly project: ProjectRuntime
}

/** Everything the event subscription needs: the revocation host plus the activation's signal. */
export interface EventStreamDeps extends RuntimeDeps {
  readonly activation: LocationActivation
}

/** The fields `execute.before` / `execute.after` share that this module reads. */
interface ToolHookEvent {
  readonly tool: string
  readonly sessionID: string
  readonly input: unknown
}

/** Drops the structured-output tool for compaction and stateless generation. */
function dropStructured(event: { tools: Record<string, unknown> }): void {
  delete event.tools[STRUCTURED_OUTPUT_TOOL]
}

/**
 * Registers every session, permission, tool and shell hook.
 *
 * The event subscription is deliberately separate ({@link startEventStream}): hooks need no
 * activation, so a reload can register them BEFORE replacing the live activation.
 */
export async function registerHooks(ctx: Plugin.Context, deps: HookDeps): Promise<void> {
  await ctx.session.hook("prompt", (event: SessionPrompt) => {
    onSessionPrompt(event, deps.project, deps.coordinator)
  })

  await ctx.session.hook("context", async (event: SessionContext) => {
    await handleContext(event, deps)
  })

  // Compaction and stateless generation never carry a structured-output contract. Deleting the
  // tool is what makes a call to it unavailable rather than silently ignored.
  await ctx.session.hook("compaction", dropStructured)
  await ctx.session.hook("generate", dropStructured)

  await ctx.session.hook("experimental.model.resolve", async (event: SessionModelResolve) => {
    await onModelResolve(event, deps.project, deps.coordinator, async (model) => {
      const models = await deps.host.listModels()
      const info = models.find(
        (entry) => entry.providerID === model.providerID && entry.modelID === model.id,
      )
      return info === undefined ? undefined : resolveUltracodeVariant(info.variants)
    })
  })

  await ctx.permission.hook("evaluate", async (event: PermissionEvaluation) => {
    await evaluatePermission(event, deps)
  })

  await ctx.tool.hook("execute.before", (event) => {
    beforeTool(event, deps)
  })
  await ctx.tool.hook("execute.after", (event) => {
    afterTool(event, deps)
  })

  await ctx.shell.hook("create.before", (event: ShellCreateBefore) => {
    beforeShell(event, deps)
  })
}

/**
 * Starts the resilient event subscription on this activation's abort signal.
 *
 * Called right after `activateLocation`, so the loop's signal is the SAME generation the rest of
 * setup registered against.
 */
export function startEventStream(ctx: Plugin.Context, deps: EventStreamDeps): void {
  void consumeEvents(ctx, deps)
}

/**
 * Handles one `hook("context")` call.
 *
 * Three mutually exclusive paths:
 * 1. a stale orphan — strip every tool and interrupt it, so a V2 restart cannot wake a dead
 *    workflow child into a token-spending turn;
 * 2. an owned child — inject its contract/schema and strip every recursion and disallowed tool;
 * 3. an ordinary session — remove StructuredOutput, hide the workflow tools from subagents, and
 *    append the ephemeral ultracode and live-run reminders.
 */
async function handleContext(event: SessionContext, deps: HookDeps): Promise<void> {
  const { coordinator, host } = deps
  if (!coordinator.owns(event.sessionID)) {
    const session = await host.getSession(event.sessionID)
    const ultraopen = ultraopenMetadataOf(session?.metadata)
    if (ultraopen !== undefined && ultraopen["bootId"] !== coordinator.processBootId) {
      // A child from a previous OS process: V2 may wake it after a restart. Give it no tools and
      // interrupt it, so the wake costs zero tokens and ends at once.
      event.tools = {}
      void host.interruptSession(event.sessionID)
      return
    }
  }

  const child = coordinator.childOf(event.sessionID)
  if (child !== undefined) {
    if (child.contractText !== undefined && !event.system.some((part) => part.text === child.contractText)) {
      event.system.push({ type: "text", text: child.contractText })
    }

    if (child.schema === undefined) {
      delete event.tools[STRUCTURED_OUTPUT_TOOL]
    } else {
      event.tools[STRUCTURED_OUTPUT_TOOL] = {
        description: STRUCTURED_OUTPUT_DESCRIPTION,
        input: normalizeStructuredSchema(child.schema),
      }
    }

    for (const tool of CHILD_DENIED_TOOLS) {delete event.tools[tool]}
    for (const tool of child.disallowedTools ?? []) {delete event.tools[tool]}
    await stripAncestorHiddenTools(event, child, deps)
    return
  }

  delete event.tools[STRUCTURED_OUTPUT_TOOL]
  const agent = await host.getAgent(event.agent)
  if (agent?.mode === "subagent") {
    delete event.tools[WORKFLOW_TOOL]
    delete event.tools[STATUS_TOOL]
  }

  // The reminders operate on request messages only; nothing they add is persisted.
  event.messages = onSessionContext(event, deps.project, deps.coordinator)
}

/**
 * Removes every tool a live ancestor now wholly disables, so a parent switch takes effect here.
 *
 * The chain resolves ONCE for the whole tool record; an unresolvable chain fails closed and leaves
 * only `StructuredOutput`, this plugin's own capture channel.
 */
async function stripAncestorHiddenTools(
  event: SessionContext,
  child: NonNullable<ReturnType<RuntimeCoordinator["childOf"]>>,
  deps: HookDeps,
): Promise<void> {
  const chain = await resolveAncestorChain(
    event.sessionID,
    child.parentSessionID,
    createAncestorLookup(deps.host),
  )
  for (const tool of Object.keys(event.tools)) {
    if (tool === STRUCTURED_OUTPUT_TOOL) {continue}
    if (!chain.ok || isHiddenByAncestors(tool, chain.rulesets)) {delete event.tools[tool]}
  }
}

/**
 * The live permission hook.
 *
 * An owned child is never more privileged than its ancestors: the resolved chain intersects with
 * the child's own configured effect on every action, and an unresolvable chain denies.
 * `StructuredOutput` is exempt — it is this plugin's own capture channel, and the schema'd child
 * cannot answer without it. Shell resources that invoke `opencode` are denied outright.
 */
async function evaluatePermission(event: PermissionEvaluation, deps: HookDeps): Promise<void> {
  if (event.action === STRUCTURED_OUTPUT_TOOL) {return}

  const child = deps.coordinator.childOf(event.sessionID)
  if (child === undefined) {
    // An ultraopen child this process does not own is an orphan from a previous boot. It has no
    // live ancestor chain to inherit from, so the only safe effect is deny.
    const session = await deps.host.getSession(event.sessionID)
    if (ultraopenMetadataOf(session?.metadata) !== undefined) {
      event.effect = "deny"
      event.message = "This workflow child belongs to a previous opencode process and cannot act."
    }
    return
  }

  if (event.action === "shell" && event.resources.some((resource) => shellInvokesOpencode(resource))) {
    event.effect = "deny"
    event.message = "A workflow subagent cannot start another opencode process."
    return
  }

  const lookup = createAncestorLookup(deps.host),
   chain = await resolveAncestorChain(event.sessionID, child.parentSessionID, lookup)
  if (!chain.ok) {
    event.effect = "deny"
    event.message = chain.message
    return
  }

  const childConfigured = await configuredEffectOfChild(event, lookup),
   verdict = evaluateResolvedAncestors(chain.rulesets, {
     action: event.action,
     resources: event.resources,
     currentEffect: event.effect,
     ...(childConfigured === undefined ? {} : { childConfiguredEffect: childConfigured }),
   })
  event.effect = verdict.effect
  if (verdict.message !== undefined) {event.message = verdict.message}
}

/**
 * The child's own configured policy for this request.
 *
 * `evaluateResolvedAncestors` preserves a saved `Allow always` only when the child itself would
 * have asked. Without this the walk cannot tell a child allow from a user's saved approval, so
 * every ancestor ask re-prompts the user in perpetuity. An unresolvable session or agent stays
 * `undefined`, which fails toward `ask` rather than widening the child.
 */
async function configuredEffectOfChild(
  event: PermissionEvaluation,
  lookup: AncestorPolicyLookup,
): Promise<PermissionEffect | undefined> {
  const resolved = await resolveSessionRuleset(event.sessionID, lookup)
  return resolved.ok ? configuredEffect(event.action, event.resources, resolved.ruleset) : undefined
}

/**
 * Layer 1–3 recursion containment at the tool boundary.
 *
 * A fork can drop the child's ruleset and a config edit can re-enable a tool, so this hook refuses
 * the call even when the model can see it. A child shell is additionally authorized here, then
 * matched by the shell-creation hook to stamp `ULTRAOPEN_ACTIVE=1` without touching user shells.
 */
function beforeTool(event: ToolHookEvent, deps: HookDeps): void {
  const child = deps.coordinator.childOf(event.sessionID)
  if (child === undefined) {return}

  if (CHILD_DENIED_TOOLS.has(event.tool) || (child.disallowedTools ?? []).includes(event.tool)) {
    throw new ToolError({
      message: `The ${event.tool} tool is not available inside a workflow subagent.`,
    })
  }
  const shell = shellInputOf(event.input)
  if (event.tool !== "shell" || shell === undefined) {return}
  if (shellInvokesOpencode(shell.command)) {
    throw new ToolError({
      message: "A workflow subagent cannot start another opencode process.",
    })
  }
  deps.coordinator.pushPendingShell(deps.project.projectKey, {
    command: shell.command,
    ...(shell.cwd === undefined ? {} : { cwd: shell.cwd }),
    expiresAt: Date.now() + SHELL_TOKEN_TTL_MS,
  })
}

/** Cleans a token whose shell-creation hook never ran (for example a call interrupted first). */
function afterTool(event: ToolHookEvent, deps: HookDeps): void {
  if (event.tool !== "shell") {return}
  const shell = shellInputOf(event.input)
  if (shell === undefined) {return}
  deps.coordinator.consumePendingShell(deps.project.projectKey, shell.command, shell.cwd)
}

/** Marks this shell creation as engine-owned only when it consumed a child's token. */
function beforeShell(event: ShellCreateBefore, deps: HookDeps): void {
  if (!deps.coordinator.consumePendingShell(deps.project.projectKey, event.command, event.cwd)) {return}
  event.env["ULTRAOPEN_ACTIVE"] = "1"
}

/**
 * Revokes a child's pending permission requests whose live ancestor chain now denies them.
 *
 * This is the other half of `#149`: the evaluate hook stops NEW asks, and this removes asks that
 * were already on screen when the parent switched to a tighter agent. The chain resolves ONCE for
 * every pending request, and an unresolvable chain rejects them all.
 */
async function revokeStalePermissions(childSessionID: string, deps: RuntimeDeps): Promise<void> {
  const child = deps.coordinator.childOf(childSessionID)
  if (child === undefined) {return}
  // Ask for the pending asks BEFORE walking the ancestor chain: a child with nothing on screen
  // costs no session reads on every turn event.
  const pending = await deps.host.listPendingPermissions(childSessionID)
  if (pending.length === 0) {return}
  const chain = await resolveAncestorChain(
    childSessionID,
    child.parentSessionID,
    createAncestorLookup(deps.host),
  )
  for (const request of pending) {
    if (request.action === STRUCTURED_OUTPUT_TOOL) {continue}
    const verdict = chain.ok
      ? evaluateResolvedAncestors(chain.rulesets, {
        action: request.action,
        resources: request.resources,
        currentEffect: "ask",
      })
      : { effect: "deny" as const, message: chain.message }
    if (verdict.effect !== "deny") {continue}
    await deps.host.rejectPermission(
      childSessionID,
      request.id,
      verdict.message ?? "the parent's live permissions no longer allow this action",
    ).catch(() => undefined)
  }
}

/**
 * Consumes the V2 event stream, re-subscribing after a transport failure until the activation is
 * aborted. The stream is live-only and global; `onV2Event` filters by payload.
 */
async function consumeEvents(ctx: Plugin.Context, deps: EventStreamDeps): Promise<void> {
  const { signal } = deps.activation.abortController
  while (!signal.aborted) {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        onV2Event(event, deps.coordinator, (childSessionID) => {
          void revokeStalePermissions(childSessionID, deps)
        })
        if (signal.aborted) {return}
      }
    } catch {
      // A dropped stream is normal on restart; re-subscribe unless this activation is done.
    }
    if (!signal.aborted) {await delay(250)}
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {setTimeout(resolve, ms)})
}

/** The `shell` tool's input fields this module reads. */
function shellInputOf(input: unknown): { command: string; cwd?: string | undefined } | undefined {
  if (typeof input !== "object" || input === null) {return undefined}
  const record = input as Record<string, unknown>,
   command = record["command"]
  if (typeof command !== "string" || command.trim() === "") {return undefined}
  const cwd = record["cwd"]
  return { command, ...(typeof cwd === "string" ? { cwd } : {}) }
}
