import { registry } from "../singleton.js"
import { recordAgentEvent } from "../resume/recording.js"
import type { OpencodeClient } from "../types.js"
import { onSessionIdle } from "../tool/background.js"

/**
 * The `event` hook: one seam, three jobs.
 *
 * Extracted from the plugin factory (src/server/index.ts) because the hook had grown past the
 * factory's line and dependency budgets, and because its three responsibilities — the idle
 * deadline's activity map, the agent recording's capture seam, and the hydration idle nudge —
 * share one spine: every live part event of an engine-owned session arrives here.
 */

/** The Bus event envelope this hook reads; the properties the plugin actually consumes. */
export interface BusEvent {
  type?: string
  properties?: {
    part?: { sessionID?: string }
    info?: { sessionID?: string }
    sessionID?: string
  }
}

/** The host contract's hook input: `{ event }`, possibly absent. */
export interface EventHookInput {
  event?: BusEvent
}

/**
 * Feeds the idle deadline's activity map, records the agent recording, and drives the
 * hydration idle nudge.
 *
 * Every live message update touches the emitting child's last-activity stamp. Bus events are
 * the only progress signal that covers schema'd children: `format` poisons the REST message
 * listing, but part events are emitted live regardless. Touching is scoped to engine-owned
 * sessions, so the user's own sessions never inflate the map.
 *
 * The agent recording (#150 / ADR-0004): every live part event of an engine-owned child appends
 * to that agent's per-agent JSONL in its run directory — always on, append-only, written as
 * received, so the joined lines read as the child's full part stream (for a schema-forced
 * child, whose native transcript view renders blank because `format` poisons the message
 * listing, this recording is the only view that covers it). Replayed agents spawn no session,
 * so nothing records for them; a stopped or crashed child keeps what had already flowed.
 *
 * `session.idle` (captured v1.18.31: `{ type: "session.idle", properties: { sessionID } }`,
 * deprecated upstream but still published) arms the missed-wake nudge for a session whose last
 * word is an unanswered hydration notification. Fire-and-forget: the hook is synchronous by
 * contract and must never reject.
 */
export function onBusEvent(input: EventHookInput | undefined, client: OpencodeClient): void {
  const event = input?.event
  if (event?.type === "session.idle") {
    const sessionID = event.properties?.sessionID
    if (sessionID !== undefined) {void onSessionIdle(client, sessionID)}
    return
  }
  if (event?.type !== "message.part.updated" && event?.type !== "message.updated") {return}
  const sessionID = event.properties?.part?.sessionID ?? event.properties?.info?.sessionID
  if (sessionID !== undefined) {
    registry.touchActivity(sessionID)
    recordAgentEvent(sessionID, { type: event.type, properties: event.properties })
  }
}
