import { DeadlineExceededError, withDeadline } from "../runtime/deadline.js"
import { DEFAULT_AGENT_DEADLINE_MS, DEFAULT_AGENT_IDLE_MS } from "../script/limits.js"
import type { ChildSessionRecord, RuntimeCoordinator } from "../runtime/coordinator.js"
import type { HostModelRef, HostPort, HostTurnResult } from "../host/port.js"
import { childRuleset } from "./permission.js"
import type { Ruleset } from "./permission.js"
import { isObjectRootSchema, unwrapCaptured } from "./validate.js"

/**
 * Child-session creation and one prompted turn, over the {@link HostPort}.
 *
 * Every child this engine creates is UNPARENTED on the host: V2's native `SubagentReport` fires on
 * every session carrying a `parentID`, steering the parent mid-workflow and overriding the child's
 * worktree location. Lineage lives in `metadata.ultraopen` instead, and the recursion guard reads
 * both that metadata and the in-memory coordinator.
 */

/** Why an agent produced no usable result. Surfaced per-agent so partial coverage is never silent. */
export type NullReason =
  | "aborted"
  | "idle-deadline"
  | "deadline"
  | "schema-failed"
  | "context-overflow"
  | "api-error"
  | "spawn-failed"
  | "prompt-failed"

export type SpawnOutcome =
  | { ok: true; text: string; structured?: unknown; outputTokens: number; sessionID: string }
  | { ok: false; reason: NullReason; detail: string; outputTokens?: number; sessionID?: string }

/** Everything one prompted turn needs; the wall/idle bounds and the shared coordinator. */
export interface PromptChildOptions {
  label: string
  coordinator: RuntimeCoordinator
  schema?: Record<string, unknown> | undefined
  deadlineMs?: number | undefined
  /** Inactivity bound for the child; 0 disables it. Idle resets on observed child progress. */
  idleMs?: number | undefined
  signal?: AbortSignal | undefined
}

export interface SpawnOptions extends PromptChildOptions {
  prompt: string
  runId: string
  parentSessionID: string
  /**
   * Sessions above the parent, nearest first. Recorded in `metadata.ultraopen` so the live
   * ancestor permission walk (#149) can rebuild the chain after a restart.
   */
  ancestorSessionIDs: readonly string[]
  /** The project runtime key whose coordinator registry owns this child. */
  projectKey: string
  /** Subagent type, validated against the agent list before spawning. */
  agentType?: string | undefined
  /** The agent call's position in its run's schedule (#150). */
  agentIndex?: number | undefined
  model?: HostModelRef | undefined
  /** Resolved against the model's real variant map by the caller; never a hardcoded "xhigh". */
  variant?: string | undefined
  /** Contract text appended to the child's system prompt by the host's context hook. */
  system?: string | undefined
  inheritedPermission?: Ruleset | undefined
  disallowedTools?: readonly string[] | undefined
  /** Working directory for an isolated agent. Routes the child session at its own worktree. */
  directory?: string | undefined
  /** Fired once the child exists and is registered — identity first, announcement second. */
  onChildCreated?: ((sessionID: string) => void) | undefined
}

/**
 * Creates a child session and runs one prompt in it.
 *
 * Split from prompting so the structured-output ladder can retry in the SAME session — which
 * preserves the child's research and is the only construction that repairs a compaction-stripped
 * turn.
 */
export async function spawn(host: HostPort, options: SpawnOptions): Promise<SpawnOutcome> {
  const created = await createChild(host, options)
  if (!created.ok) {return { ok: false, reason: created.reason, detail: created.detail }}
  return await promptChild(host, created.sessionID, options.prompt, options)
}

export type CreateChildResult =
  | { ok: true; sessionID: string }
  | { ok: false; detail: string; reason: "spawn-failed" | "api-error" }

/** Creates the child session, moves it onto its worktree, and registers its lineage. */
export async function createChild(host: HostPort, options: SpawnOptions): Promise<CreateChildResult> {
  const { coordinator } = options,
   // Worktree isolation is real only when the child leaves the canonical checkout. The DENY on the
   // original directory is what stops a child editing behind the isolation's back, even when the
   // parent's inherited rules or a saved `Allow always` cover that path.
   worktreeIsolated = options.directory !== undefined && options.directory !== host.location.canonical,
   created = await host.createChildSession({
    title: `ultraopen · ${options.label}`,
    metadata: {
      ultraopen: {
        runId: options.runId,
        bootId: coordinator.processBootId,
        parentSessionID: options.parentSessionID,
        ancestorSessionIDs: [...options.ancestorSessionIDs],
        label: options.label,
        index: options.agentIndex ?? 0,
      },
    },
    permissions: childRuleset({
      inherited: options.inheritedPermission,
      structured: options.schema !== undefined,
      disallowedTools: options.disallowedTools,
      ...(worktreeIsolated ? { blockDirectory: host.location.canonical } : {}),
    }),
    ...(options.agentType === undefined ? {} : { agent: options.agentType }),
    ...(options.model === undefined ? {} : { model: withVariant(options.model, options.variant) }),
    ...(options.directory === undefined ? {} : { location: options.directory }),
  })
  // Carry the real reason forward: "session creation returned no id" tells the user nothing about
  // why, and this is the first place a misconfigured agent name or a rejected body surfaces.
  if (!created.ok) {return { ok: false, reason: "spawn-failed", detail: created.detail }}

  const { sessionID } = created
  // Verify the child actually landed on its worktree. Fail CLOSED: a child editing the canonical
  // checkout behind the isolation's back is worse than one that never started.
  if (options.directory !== undefined) {
    const moved = await host.moveSession(sessionID, options.directory)
    if (!moved.ok) {
      await host.interruptSession(sessionID).catch(() => false)
      return { ok: false, reason: "api-error", detail: moved.detail }
    }
  }

  const record: ChildSessionRecord = {
    runId: options.runId,
    projectKey: options.projectKey,
    parentSessionID: options.parentSessionID,
    ancestorSessionIDs: options.ancestorSessionIDs,
    index: options.agentIndex ?? 0,
    label: options.label,
    lastActivityAt: Date.now(),
    currentAttempt: 0,
    ...(options.system === undefined ? {} : { contractText: options.system }),
    ...(options.schema === undefined
      ? {}
      : { schema: options.schema, wrapped: !isObjectRootSchema(options.schema) }),
    ...(options.disallowedTools === undefined ? {} : { disallowedTools: options.disallowedTools }),
  }
  // Identity before announcement: progress must never advertise a child the coordinator does not
  // know about yet.
  coordinator.registerChild(sessionID, record)
  options.onChildCreated?.(sessionID)
  return { ok: true, sessionID }
}

/**
 * Runs one prompt turn in an existing child session.
 *
 * The turn is raced against the parent's abort signal and the host-side wall/idle bounds, and any
 * kill calls `interruptSession` so the remote turn actually stops. Structured payloads are read
 * from the coordinator's per-attempt capture slot — never parsed out of assistant prose, which a
 * model can produce even when no `StructuredOutput` call ever happened.
 */
export async function promptChild(
  host: HostPort,
  sessionID: string,
  prompt: string,
  options: PromptChildOptions,
): Promise<SpawnOutcome> {
  const { signal } = options
  if (signal?.aborted) {return { ok: false, reason: "aborted", detail: "aborted before start", sessionID }}

  const messageID = mintMessageID(),
   interrupt = async (): Promise<void> => {
     await host.interruptSession(sessionID).catch(() => false)
   }
  let rejectAbort: ((reason: unknown) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  }),
   onAbort = (): void => {
    void interrupt()
    rejectAbort?.(new Error("the parent run was aborted"))
   }
  signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const response = await withDeadline(Promise.race([host.runTurn({ sessionID, messageID, text: prompt }), aborted]), {
      ms: options.deadlineMs ?? DEFAULT_AGENT_DEADLINE_MS,
      idleMs: options.idleMs ?? DEFAULT_AGENT_IDLE_MS,
      // The coordinator's activity map is fed by the plugin's V2 event hook; session events are
      // the only progress signal that covers schema'd children.
      activity: () => options.coordinator.lastActivity(sessionID),
      label: options.label,
      onTimeout: interrupt,
    })
    if (!response.ok) {return { ok: false, reason: "api-error", detail: response.detail, sessionID }}
    return interpretTurn(response.turn, sessionID, options.schema !== undefined, options.coordinator.childOf(sessionID))
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      // The two kill shapes are distinguished because only an idle kill restarts: a wall-clock
      // kill means the agent produced continuously for the whole ceiling, and a fresh attempt
      // would just re-pay hours of work against a brand-new ceiling.
      if (signal?.aborted) {return { ok: false, reason: "aborted", detail: "parent aborted", sessionID }}
      return {
        ok: false,
        reason: error.kind === "idle" ? "idle-deadline" : "deadline",
        detail: error.message,
        sessionID,
      }
    }
    if (signal?.aborted) {return { ok: false, reason: "aborted", detail: "parent aborted", sessionID }}
    return { ok: false, reason: "api-error", detail: describe(error), sessionID }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

/**
 * Turns a settled host turn into an outcome.
 *
 * The retry trigger for a schema'd call is a MISSING per-attempt capture, never `text`. A child
 * can write a JSON-looking paragraph without ever calling `StructuredOutput`, and consumer code
 * must not be handed that string where its schema promised an object.
 */
export function interpretTurn(
  turn: HostTurnResult,
  sessionID: string,
  wantedSchema: boolean,
  record: Pick<ChildSessionRecord, "captured" | "currentAttempt" | "wrapped"> | undefined,
): SpawnOutcome {
  const outputTokens = tokensOf(turn.outputTokens),
   errorType = turn.error?.type,
   kind = normalizeErrorType(errorType)
  if (turn.outcome === "interrupted" || kind.includes("abort")) {
    return { ok: false, reason: "aborted", detail: turn.error?.message ?? "run was interrupted", sessionID, outputTokens }
  }
  if (kind.includes("contextoverflow")) {
    return {
      ok: false,
      reason: "context-overflow",
      detail: "child exhausted its context window",
      sessionID,
      outputTokens,
    }
  }
  if (errorType !== undefined) {
    return { ok: false, reason: "api-error", detail: turn.error?.message ?? errorType, sessionID, outputTokens }
  }
  if (turn.outcome === "failed") {
    return { ok: false, reason: "api-error", detail: "the child turn failed", sessionID, outputTokens }
  }

  if (wantedSchema) {
    const captured = record?.captured
    if (record === undefined || captured === undefined || captured.attempt !== record.currentAttempt) {
      return { ok: false, reason: "schema-failed", detail: "no structured output was produced", sessionID, outputTokens }
    }
    return {
      ok: true,
      text: turn.text,
      structured: unwrapCaptured(captured.value, record.wrapped === true),
      outputTokens,
      sessionID,
    }
  }
  return { ok: true, text: turn.text, outputTokens, sessionID }
}

/** Merges the resolved variant onto the model selection; a bare ref stays bare. */
function withVariant(model: HostModelRef, variant: string | undefined): HostModelRef {
  if (variant === undefined || model.variant !== undefined) {return model}
  return { ...model, variant }
}

/** `MessageAbortedError` / `ContextOverflowError` compare by their alphanumeric skeleton. */
function normalizeErrorType(type: string | undefined): string {
  return (type ?? "").toLowerCase().replaceAll(/[^a-z]/gu, "")
}

/** Reads tokens defensively: a drifted response shape must not poison budget arithmetic. */
export function tokensOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

/** V2 enforces the `msg_` prefix on every session message id. */
export function mintMessageID(): string {
  return `msg_${globalThis.crypto.randomUUID()}`
}

function describe(error: unknown): string {
  if (error === undefined || error === null) {return "unknown error"}
  if (error instanceof Error) {return error.message}
  if (typeof error === "string") {return error}
  if (typeof error === "object" && "name" in error && typeof error.name === "string") {return error.name}
  return JSON.stringify(error).slice(0, 200)
}
