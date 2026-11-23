/**
 * Pure hexagonal host boundary.
 *
 * Everything the workflow engine needs from the OpenCode runtime is expressed here as plain domain
 * types. This module imports nothing: no `@opencode/*`, no `effect`, no `node:*`. The adapter that
 * implements the port is the only place allowed to touch a host SDK, so tests and the engine can
 * depend on this contract without a live host.
 */

/** A provider/model selection the host understands, expressed with the domain's own field name. */
export interface HostModelRef {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string | undefined
}

/** A catalog entry: a model plus the variants it exposes for per-request overrides. */
export interface HostModelInfo {
  readonly providerID: string
  readonly modelID: string
  readonly variants: readonly string[]
}

/** One stored permission rule. The last matching rule wins on the host. */
export interface HostPermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "ask" | "deny"
}

/** A session as the engine observes it, normalized away from wire representation. */
export interface HostSessionInfo {
  readonly id: string
  readonly parentID?: string | undefined
  readonly projectID: string
  readonly directory: string
  readonly agent?: string | undefined
  readonly model?: HostModelRef | undefined
  readonly permissions?: readonly HostPermissionRule[] | undefined
  readonly metadata?: Record<string, unknown> | undefined
  /** Cumulative output tokens recorded by the host, across compactions. */
  readonly outputTokens: number
}

/** An agent definition as the engine observes it. */
export interface HostAgentInfo {
  readonly id: string
  readonly mode: "primary" | "subagent" | "all"
  readonly hidden: boolean
  readonly permissions: readonly HostPermissionRule[]
}

/** A permission request currently waiting for a human decision. */
export interface HostPendingPermission {
  readonly id: string
  readonly action: string
  readonly resources: readonly string[]
}

/** The terminal result of one prompted turn. */
export interface HostTurnResult {
  readonly outcome: "succeeded" | "failed" | "interrupted"
  readonly text: string
  readonly error?: { readonly type: string; readonly message: string } | undefined
  readonly outputTokens: number
}

/**
 * Everything needed to create an unparented workflow child session.
 *
 * There is deliberately no `parentID` field: V2's `SubagentReport` fires on every session carrying
 * one, which would steer the parent mid-workflow and override the child's location. Lineage lives in
 * `metadata.ultraopen` instead, and making `parentID` unrepresentable keeps that rule type-enforced.
 */
export interface CreateChildSessionInput {
  readonly title: string
  readonly agent?: string | undefined
  readonly model?: HostModelRef | undefined
  readonly location?: string | undefined
  readonly metadata: Record<string, unknown>
  readonly permissions?: readonly HostPermissionRule[] | undefined
}

/** The host surface the workflow engine drives. */
export interface HostPort {
  readonly location: {
    readonly directory: string
    readonly canonical: string
    readonly projectID: string
  }
  readonly defaultModel: () => Promise<HostModelRef | undefined>
  readonly listModels: () => Promise<readonly HostModelInfo[]>
  readonly getSession: (sessionID: string) => Promise<HostSessionInfo | undefined>
  readonly getAgent: (agentID: string, directory?: string) => Promise<HostAgentInfo | undefined>
  readonly listAgents: (directory?: string) => Promise<readonly HostAgentInfo[]>
  readonly listPendingPermissions: (sessionID: string) => Promise<readonly HostPendingPermission[]>
  readonly rejectPermission: (sessionID: string, requestID: string, message: string) => Promise<void>
  readonly createChildSession: (
    input: CreateChildSessionInput,
  ) => Promise<{ ok: true; sessionID: string } | { ok: false; detail: string }>
  readonly moveSession: (
    sessionID: string,
    directory: string,
  ) => Promise<{ ok: true } | { ok: false; detail: string }>
  readonly runTurn: (input: { sessionID: string; messageID: string; text: string }) => Promise<
    { ok: true; turn: HostTurnResult } | { ok: false; detail: string }
  >
  readonly interruptSession: (sessionID: string) => Promise<boolean>
  readonly admitSynthetic: (input: {
    sessionID: string
    id: string
    text: string
    description?: string | undefined
    metadata?: Record<string, unknown> | undefined
    delivery?: "steer" | "queue" | undefined
    resume?: boolean | undefined
  }) => Promise<"admitted" | "session-missing" | "conflict" | "error">
}

/**
 * A {@link HostPort} whose every call is resolved through `resolve` at CALL time.
 *
 * This is the reload seam. A same-PID plugin reload replaces an activation's host without
 * touching the runs that already captured this object, so in-flight host calls keep landing on
 * whichever `HostPort` is current. `location` is a getter for the same reason: a stale directory
 * after a handoff would misroute child sessions and manifests.
 */
export function createReloadableHost(resolve: () => HostPort): HostPort {
  return {
    get location() {
      return resolve().location
    },
    defaultModel: () => resolve().defaultModel(),
    listModels: () => resolve().listModels(),
    getSession: (sessionID) => resolve().getSession(sessionID),
    getAgent: (agentID, directory) => resolve().getAgent(agentID, directory),
    listAgents: (directory) => resolve().listAgents(directory),
    listPendingPermissions: (sessionID) => resolve().listPendingPermissions(sessionID),
    rejectPermission: (sessionID, requestID, message) => resolve().rejectPermission(sessionID, requestID, message),
    createChildSession: (input) => resolve().createChildSession(input),
    moveSession: (sessionID, directory) => resolve().moveSession(sessionID, directory),
    runTurn: (input) => resolve().runTurn(input),
    interruptSession: (sessionID) => resolve().interruptSession(sessionID),
    admitSynthetic: (input) => resolve().admitSynthetic(input),
  }
}
