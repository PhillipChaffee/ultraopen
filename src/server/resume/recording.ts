import { appendFile, mkdir, open, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { RuntimeCoordinator } from "../runtime/coordinator.js"
import { recordingPath } from "./store.js"

/**
 * The V2 agent recording's write path (#150 / ADR-0004).
 *
 * Every finalized event of an engine-owned child is appended, one per line, to that agent's JSONL
 * file under the run directory. V2 delivers the event's `data` container and a unique `id`; the id
 * is claimed through the coordinator's bounded FIFO, so a duplicate delivery (two plugin copies in
 * one process) costs O(1) and never doubles a line.
 *
 * The recording is append-only and always on: no option gates it, and the run directory's
 * retention bounds the disk. It is the transcript's representation on disk — the only
 * reader-visible form for a schema-forced child, whose native transcript view renders blank
 * because `format` poisons the message listing the view reads.
 *
 * Writers are chained per file (record order = bus delivery order, appends never interleave) and
 * never coalesce. The discipline is the journal's own: best-effort, tolerant of a torn tail, and
 * incapable of breaking its caller, because the subscription that drives it must survive.
 */

/** One recorded bus event: the V2 envelope's durable fields. */
export interface RecordedEvent {
  readonly id?: string | undefined
  readonly type: string
  readonly data: Record<string, unknown>
}

/** The per-recording write chain, keyed by the file path it serializes onto. */
const writers = new Map<string, Promise<void>>()

/** One best-effort receiver for this seam's failure cleanups. */
const forget = (): void => {}

/**
 * Appends one event's line to the agent's recording.
 *
 * Called from the event hook only for finalized/durable events. A session the coordinator does
 * not own (the user's own sessions, another engine's children) is skipped with no file created.
 * The append is chained onto the file's own writer, so arrival order is line order.
 */
export function recordAgentEvent(
  event: RecordedEvent,
  coordinator: RuntimeCoordinator,
  env?: NodeJS.ProcessEnv,
): void {
  const sessionID = event.data["sessionID"]
  if (typeof sessionID !== "string") {return}
  const child = coordinator.childOf(sessionID)
  if (child === undefined) {return}
  // The event id is the dedupe key: the first claim wins, a duplicate delivery is dropped.
  if (event.id !== undefined && !coordinator.markEventSeen(event.id)) {return}
  const path = recordingPath(child.runId, child.index, child.label, env),
   text = `${serializeEvent(event)}\n`
  queuedWrite(path, text, !writers.has(path))
}

/**
 * Chains one write onto the recording's writer queue and lets it settle to nothing.
 *
 * An append failure degrades the recording (best-effort like the flushes it mirrors); a `void`-ed
 * promise chain here rejects nowhere. Self-cleaning: once the chain settles and no newer write
 * claimed it, the map entry is dropped.
 */
function queuedWrite(path: string, text: string, started: boolean): void {
  const inFlight = writers.get(path),
   queued = (inFlight ?? Promise.resolve()).then(() => appendRecordingLine(path, text, started)).catch(forget)
  writers.set(path, queued)
  void queued.finally(() => {
    if (writers.get(path) === queued) {writers.delete(path)}
  })
}

/** Test-only: resolves when every queued append has settled, so assertions are race-free. */
export async function settleRecordings(): Promise<void> {
  while (writers.size > 0) {
    const pending = Array.from(writers.values(), (queue) => queue.catch(forget))
    await Promise.all(pending)
  }
}

/** Test-only: drops every queued chain, restoring a clean process-wide state. */
export function resetRecordingsForTests(): void {
  writers.clear()
}

/**
 * One line to disk, with the two tolerances the acceptance names.
 *
 * - TORN TAIL: a crash can leave a final line without its newline; the first append of THIS
 *   process re-establishes the boundary so the next line is never glued onto the partial one.
 * - FAILED APPEND: the retry carries its own leading newline, so even an unknown partial state
 *   cannot glue the retried line onto a torn one.
 */
async function appendRecordingLine(path: string, event: string, firstWriteOfProcess: boolean): Promise<void> {
  if (firstWriteOfProcess) {
    // The recordings directory is created lazily by the first write: a nested per-agent directory
    // must not cost an mkdir per event, and ensureRunDir cannot know it needs one in advance.
    await mkdir(dirname(path), { recursive: true }).catch(forget)
  }
  const boundary = firstWriteOfProcess ? await trailingNewlineMissing(path) : "",
   line = `${boundary}${event}`
  try {
    await appendFile(path, line, "utf8")
  } catch {
    await appendFile(path, `\n${line}`, "utf8").catch(forget)
  }
}

/** `"\n"` when the file's last byte is not a newline; `""` when missing, empty or terminated. */
async function trailingNewlineMissing(path: string): Promise<"\n" | ""> {
  try {
    const info = await stat(path)
    if (info.size === 0) {return ""}
    const handle = await open(path, "r")
    try {
      const byte = Buffer.alloc(1)
      await handle.read(byte, 0, 1, info.size - 1)
      // Byte-compared: the last byte of a torn multibyte character is not a newline either way.
      return byte[0] === 0x0A ? "" : "\n"
    } finally {
      await handle.close().catch(forget)
    }
  } catch {
    return ""
  }
}

/**
 * One event per line: `{ at, id, type, data }`, the envelope as received.
 *
 * `data` is written verbatim, which is what makes the joined lines read as the child's full part
 * stream. A payload that cannot serialize (the JSON source is trusted, but this seam must never
 * throw) degrades to a marker rather than swallowing the whole event: shape survives.
 */
function serializeEvent(event: RecordedEvent): string {
  try {
    return JSON.stringify({ at: Date.now(), id: event.id ?? null, type: event.type, data: event.data })
  } catch {
    return JSON.stringify({ at: Date.now(), id: event.id ?? null, type: event.type, data: "<unserializable>" })
  }
}
