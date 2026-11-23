import type { RuntimeCoordinator } from "./coordinator.js"
import { recordAgentEvent } from "../resume/recording.js"

/**
 * The `ctx.event.subscribe` seam for V2 bus events.
 *
 * V2 exposes one live-only, global event stream with a unique `event.id`, and every payload lives
 * under `event.data` (V1's `properties` is gone). Three jobs share that spine:
 *
 * - ALL `session.*` events touch the owned child's last-activity stamp, including deltas — that
 *   map is the idle deadline's only progress signal for schema-forced children.
 * - Finalized/durable events append to the ADR-0004 agent recording, deduped in O(1) by id.
 * - Agent/permission/config changes notify the ancestry watcher, so live permission inheritance
 *   can be re-evaluated (#149).
 */

/** The Bus event envelope this hook reads; `data` is V2's payload container. */
export interface V2BusEvent {
  readonly id?: string | undefined
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

/**
 * Events worth recording: finalized steps, completed text/reasoning blocks, tool calls and their
 * outcomes, compactions and executions. Character deltas are deliberately absent — the recording
 * captures a transcript, not a keystroke log.
 */
function isRecorded(type: string): boolean {
  return (
    type.startsWith("session.step.") ||
    type === "session.text.ended" ||
    type === "session.reasoning.ended" ||
    type === "session.tool.called" ||
    type === "session.tool.success" ||
    type === "session.tool.failed" ||
    type.startsWith("session.compaction.") ||
    type.startsWith("session.execution.")
  )
}

function sessionIDOf(event: V2BusEvent): string | undefined {
  const sessionID = event.data["sessionID"]
  return typeof sessionID === "string" ? sessionID : undefined
}

/**
 * The owned children whose inherited stack includes the changed session.
 *
 * The coordinator keeps child lineage but no parent-to-children index, so the live-run registry is
 * the enumeration source: every child of every live run is checked against the parent/ancestor
 * chain. An undefined `changed` (a global `config.updated` or `agent.updated`) affects them all.
 */
function affectedChildren(coordinator: RuntimeCoordinator, changed?: string | undefined): string[] {
  const found = new Set<string>()
  for (const run of coordinator.runs.values()) {
    for (const childID of coordinator.sessionsOf(run.runId)) {
      const child = coordinator.childOf(childID)
      if (child === undefined) {continue}
      if (
        changed === undefined ||
        child.parentSessionID === changed ||
        child.ancestorSessionIDs.includes(changed)
      ) {
        found.add(childID)
      }
    }
  }
  return [...found]
}

/**
 * Handles one V2 bus event. Synchronous by contract and never throws: the subscription loop must
 * survive any malformed payload.
 */
export function onV2Event(
  event: V2BusEvent,
  coordinator: RuntimeCoordinator,
  onAncestorChanged?: ((sessionID: string) => void) | undefined,
): void {
  if (event.type.startsWith("session.")) {
    const sessionID = sessionIDOf(event)
    if (sessionID !== undefined && coordinator.owns(sessionID)) {coordinator.touchActivity(sessionID)}
  }
  // The recording's own envelope keeps a mutable data record; copy the read-only bus payload into
  // it rather than widening that contract.
  if (isRecorded(event.type)) {recordAgentEvent({ ...event, data: { ...event.data } }, coordinator)}
  if (
    event.type === "agent.updated" ||
    event.type === "session.agent.selected" ||
    event.type === "session.permissions" ||
    event.type === "config.updated"
  ) {
    // An agent definition or global config change names no session, so every owned child re-checks.
    const globalChange =
      event.type === "agent.updated" || event.type === "config.updated",
     changed = globalChange ? undefined : sessionIDOf(event)
    for (const childID of affectedChildren(coordinator, changed)) {onAncestorChanged?.(childID)}
  }
}
