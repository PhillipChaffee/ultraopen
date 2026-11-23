/**
 * OpenCode V2 `Context` -> {@link HostPort} adapter.
 *
 * This is the only module that touches `ctx.*`. It is typed against a small structural subset of
 * `@opencode/plugin@2.3.2`'s `Context`; the compile-time assertion below proves the real `Context`
 * still satisfies that subset, so an upstream rename fails `tsc` instead of failing at runtime.
 */
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { HostModelInfo, HostPort, HostTurnResult } from "./port.js"
import {
  admissionFailure,
  isTurnOutcome,
  lastAssistantText,
  lastIdle,
  lastTurnError,
  messageOf,
  sliceTurn,
  sumOutputTokens,
  toCreateInput,
  toHostAgentInfo,
  toHostModelRef,
  toHostSessionInfo,
  toJsonRecord,
} from "./v2-normalize.js"
import type {
  V2AgentInfo,
  V2CreateSessionInput,
  V2ModelInfo,
  V2PermissionRequest,
  V2PromptInput,
  V2SessionInfo,
  V2SessionMessage,
  V2SyntheticInput,
} from "./v2-normalize.js"

export type {
  V2AgentInfo,
  V2CreateSessionInput,
  V2ModelInfo,
  V2PermissionRequest,
  V2PromptInput,
  V2SessionInfo,
  V2SessionMessage,
  V2SyntheticInput,
} from "./v2-normalize.js"

type Context = Plugin.Context

type V2LocationInput = { readonly location?: { readonly directory?: string | undefined } | undefined } | undefined

/** The structural subset of `Context` this adapter actually drives. */
export interface V2PluginContextLike {
  readonly location: {
    readonly directory: string
    readonly project: { readonly id: string; readonly canonical: string }
  }
  readonly model: {
    readonly list: (input?: V2LocationInput) => Promise<{ readonly data: readonly V2ModelInfo[] }>
    readonly default: (input?: V2LocationInput) => Promise<{ readonly data: V2ModelInfo | null }>
  }
  readonly agent: {
    readonly get: (input: {
      readonly agentID: string
      readonly location?: { readonly directory?: string | undefined } | undefined
    }) => Promise<{ readonly data: V2AgentInfo }>
    readonly list: (input?: V2LocationInput) => Promise<{ readonly data: readonly V2AgentInfo[] }>
  }
  readonly permission: {
    readonly list: (input: { readonly sessionID: string }) => Promise<readonly V2PermissionRequest[]>
    readonly reply: (input: {
      readonly sessionID: string
      readonly requestID: string
      readonly decision: "once" | "always" | "reject"
      readonly message?: string | undefined
    }) => Promise<void>
  }
  readonly session: {
    readonly create: (input: V2CreateSessionInput) => Promise<V2SessionInfo>
    readonly get: (input: { readonly sessionID: string }) => Promise<V2SessionInfo>
    readonly move: (input: {
      readonly sessionID: string
      readonly directory: string
      readonly delivery?: "steer" | "queue" | undefined
    }) => Promise<void>
    readonly wait: (input: { readonly sessionID: string }) => Promise<void>
    readonly prompt: (input: V2PromptInput) => Promise<unknown>
    readonly context: (input: { readonly sessionID: string }) => Promise<readonly V2SessionMessage[]>
    readonly synthetic: (input: V2SyntheticInput) => Promise<unknown>
    readonly interrupt: (input: { readonly sessionID: string; readonly resume?: boolean | undefined }) => Promise<unknown>
  }
}

// Drift guard: `Context` must remain assignable to the structural subset this adapter targets.
type ContextAssignable = Context extends V2PluginContextLike ? true : never
const assertContextAssignable: ContextAssignable = true
void assertContextAssignable

/**
 * Enforces the V2 `SessionMessage.ID` contract: a non-blank ID that starts with `msg_`.
 *
 * @throws {Error} when the ID is blank or missing the required prefix.
 */
export function ensureMessageId(id: string): string {
  if (typeof id !== "string" || id.trim().length === 0 || !id.startsWith("msg_")) {
    throw new Error(`Invalid session message ID ${JSON.stringify(id)}: expected a non-empty "msg_" prefixed ID`)
  }
  return id
}

async function runTurn(
  ctx: V2PluginContextLike,
  input: { sessionID: string; messageID: string; text: string },
): Promise<{ ok: true; turn: HostTurnResult } | { ok: false; detail: string }> {
  let messageID: string
  try {
    messageID = ensureMessageId(input.messageID)
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  }
  try {
    const before = await ctx.session.get({ sessionID: input.sessionID })
    await ctx.session.prompt({ sessionID: input.sessionID, id: messageID, text: input.text, delivery: "steer" })
    await ctx.session.wait({ sessionID: input.sessionID })
    const messages = await ctx.session.context({ sessionID: input.sessionID })
    const slice = sliceTurn(messages, messageID)
    const idle = lastIdle(slice.messages)
    const settled =
      slice.afterCompaction || idle === undefined
        ? await ctx.session.get({ sessionID: input.sessionID })
        : undefined
    const outputTokens =
      slice.afterCompaction && settled !== undefined
        ? Math.max(0, settled.tokens.output - before.tokens.output)
        : sumOutputTokens(slice.messages)
    let outcome: HostTurnResult["outcome"] = "succeeded"
    if (isTurnOutcome(idle?.outcome)) {
      outcome = idle.outcome
    } else if (isTurnOutcome(settled?.outcome)) {
      outcome = settled.outcome
    }
    const error = lastTurnError(slice.messages)
    return {
      ok: true,
      turn: {
        outcome,
        text: lastAssistantText(slice.messages),
        outputTokens,
        ...(error === undefined ? {} : { error }),
      },
    }
  } catch (error) {
    return { ok: false, detail: messageOf(error) }
  }
}

/**
 * Resolves a directory to its physical path, so a symlink and its target compare equal.
 *
 * A path that no longer exists (or cannot be stat'ed) falls back to its lexical form, which still
 * matches an identical string. This is the same physical-path rule auto-resume uses for directory
 * aliases (`/var` vs `/private/var`, or a symlinked worktree).
 */
async function physicalDir(path: string): Promise<string> {
  try {return await realpath(path)} catch {return resolve(path)}
}

/** Builds the production {@link HostPort} over one OpenCode V2 plugin `Context`. */
export function createV2HostPort(ctx: V2PluginContextLike): HostPort {
  return {
    location: {
      directory: ctx.location.directory,
      canonical: ctx.location.project.canonical,
      projectID: ctx.location.project.id,
    },

    async defaultModel() {
      const output = await ctx.model.default()
      return output.data === null ? undefined : toHostModelRef(output.data)
    },

    async listModels() {
      const output = await ctx.model.list()
      return output.data.map(
        (model): HostModelInfo => ({
          providerID: model.providerID,
          modelID: model.id,
          variants: model.variants.map((variant) => variant.id),
        }),
      )
    },

    async getSession(sessionID) {
      try {
        return toHostSessionInfo(await ctx.session.get({ sessionID }))
      } catch {
        return undefined
      }
    },

    async getAgent(agentID, directory) {
      try {
        const output =
          directory === undefined
            ? await ctx.agent.get({ agentID })
            : await ctx.agent.get({ agentID, location: { directory } })
        return toHostAgentInfo(output.data)
      } catch {
        return undefined
      }
    },

    async listAgents(directory) {
      try {
        const output =
          directory === undefined ? await ctx.agent.list() : await ctx.agent.list({ location: { directory } })
        return output.data.map((agent) => toHostAgentInfo(agent))
      } catch {
        return []
      }
    },

    async listPendingPermissions(sessionID) {
      try {
        const requests = await ctx.permission.list({ sessionID })
        return requests.map((request) => ({
          id: request.id,
          action: request.action,
          resources: request.resources,
        }))
      } catch {
        return []
      }
    },

    async rejectPermission(sessionID, requestID, message) {
      await ctx.permission.reply({ sessionID, requestID, decision: "reject", message })
    },

    async createChildSession(input) {
      try {
        const created = await ctx.session.create(toCreateInput(input))
        if (created.id.length === 0) {return { ok: false, detail: "Host returned an empty session ID" }}
        return { ok: true, sessionID: created.id }
      } catch (error) {
        return { ok: false, detail: messageOf(error) }
      }
    },

    async moveSession(sessionID, directory) {
      try {
        await ctx.session.move({ sessionID, directory, delivery: "steer" })
        await ctx.session.wait({ sessionID })
        const info = await ctx.session.get({ sessionID })
        // Compare PHYSICAL paths: a symlinked worktree and its target are the same directory, and
        // V2 may report either. A lexical comparison would reject a correct move as a failure.
        const [expected, actual] = await Promise.all([physicalDir(directory), physicalDir(info.location.directory)])
        if (actual !== expected) {
          return {
            ok: false,
            detail: `Session ${sessionID} is in ${info.location.directory}, expected ${resolve(directory)}`,
          }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, detail: messageOf(error) }
      }
    },

    runTurn: (input) => runTurn(ctx, input),

    async interruptSession(sessionID) {
      try {
        await ctx.session.interrupt({ sessionID, resume: false })
        return true
      } catch {
        return false
      }
    },

    async admitSynthetic(input) {
      try {
        ensureMessageId(input.id)
        await ctx.session.synthetic({
          sessionID: input.sessionID,
          id: input.id,
          text: input.text,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.metadata === undefined ? {} : { metadata: toJsonRecord(input.metadata) }),
          ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
          ...(input.resume === undefined ? {} : { resume: input.resume }),
        })
        return "admitted"
      } catch (error) {
        return admissionFailure(error)
      }
    },
  }
}
