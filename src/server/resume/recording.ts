import { appendFile, mkdir, open, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { registry } from "../singleton.js"
import { recordingPath } from "./store.js"

/**
 * The agent recording's write path (#150 / ADR-0004).
 *
 * While a workflow child works, the plugin's `event` hook receives every Bus part event it
 * emits (`message.part.updated` / `message.updated`), already scoped to engine-owned sessions
 * by this process's registry — the same seam that feeds the idle deadline's activity map. THIS
 * module appends each such event, verbatim and one per line, to one JSONL file per agent under
 * the run directory. The recording is append-only and always on: no option gates it, and the
 * run directory's retention bounds the disk. It is the transcript's representation on disk —
 * the only reader-visible form for a schema-forced child, whose native transcript view renders
 * blank because `format` poisons the message listing the view reads.
 *
 * Writers are chained per file (the record order = the Bus delivery order, appends never
 * interleave) and never coalesce: an event that arrives lands on disk after its write cycle.
 * The discipline is the journal's own (`flushJournalEntry`): best-effort, tolerant of a torn
 * tail — a mid-write kill must not glue the next line onto the partial one — and incapable of
 * breaking its caller, because the hook that drives it is synchronous by contract and a throw
 * there would take the whole opencode server down.
 */

/** The event envelope the capture seam delivers: the Bus event as received. */
export interface RecordedEvent {
  type: string
  properties?: unknown
}

/** The per-recording write chain, keyed by the file path it serializes onto. */
const writers = new Map<string, Promise<void>>()

/**
 * The dedupe window for one process's double hooking.
 *
 * opencode instantiates the plugin once per directory, so two instances of the SAME process —
 * the project root's and a worktree-isolated child's — can both register an `event` hook, and
 * the Bus dispatches every event to both. `touchActivity` shrugs that off (map writes are
 * idempotent); a recording append would double every line. The dedupe is the same idempotence
 * trick a set can give an append: the event's envelope (type + properties, exactly as
 * delivered) marks the window; the twin hook call milliseconds later finds the digest present
 * and adds nothing. Real duplicate envelopes are unrepresentable — part events carry the
 * part's id and revision, so identical bytes cannot be two distinct events.
 */
const recentEvents = new Map<string, boolean>()
let dedupeWindow = 8192

/**
 * The one best-effort receiver for this seam's failure cleanups (persist.ts's forgetTemp, at
 * recording granularity): a failed cleanup is a degraded recording, and the hook that drives
 * the writes is synchronous by contract — no rejection may ever escape to break the host.
 */
const forget = (): void => {}

/**
 * Appends one event's line to the agent's recording.
 *
 * Called from the `event` hook for every live part event of an engine-owned session.
 * Fire-and-forget by construction: the lookup is synchronous, the append is chained onto the
 * recording's own writer (so arrival order is line order), and nothing here rejects — a disk
 * failure degrades the recording the way a journal append would, never the run.
 *
 * A session the registry does not own (the user's own sessions, a session another engine
 * spawned) is skipped with no file created: foreign-session events never record.
 */
export function recordAgentEvent(sessionID: string, event: RecordedEvent, env?: NodeJS.ProcessEnv): void {
  const owner = registry.agentOf(sessionID)
  // No child, no recording: replayed agents spawn no session and so record nothing.
  if (owner === undefined) {return}
  const envelope = serializeEnvelope(event)
  if (recentEvents.has(envelope)) {return}
  recentEvents.set(envelope, true)
  // Eviction keeps the Map bounded to the window: a hot fan-out emits far more events than
  // the window needs, and the twins that need deduping are always adjacent in dispatch order.
  if (recentEvents.size > dedupeWindow) {
    const oldest = recentEvents.keys().next()
    if (!oldest.done) {recentEvents.delete(oldest.value)}
  }
  const path = recordingPath(owner.runId, owner.index, owner.label, env),
    text = `${serializeEvent(event)}\n`
  queuedWrite(path, text, !writers.has(path))
}

/**
 * Chains one write onto the recording's writer queue and lets it settle to nothing.
 *
 * Named out of recordAgentEvent so the chain-tail cleanup is code coverage visible: an
 * append failure degrades the recording (best-effort like the flushes it mirrors), the write
 * queue is best-effort still, and a `void`-ed Promise chain here rejects nowhere.
 */
function queuedWrite(path: string, text: string, started: boolean): void {
  const inFlight = writers.get(path),
    queued = (inFlight ?? Promise.resolve()).then(() => appendRecordingLine(path, text, started)).catch(forget)
  writers.set(path, queued)
  // Self-cleaning: once the chain settles and no newer write claimed it, drop the entry so a
  // long-lived host's map holds only actively-writing recordings, never every past path.
  void queued.finally(() => {
    if (writers.get(path) === queued) {writers.delete(path)}
  })
}

/** Test-only: resolves when every queued append has settled, so assertions are race-free. */
export async function settleRecordings(): Promise<void> {
  while (writers.size > 0) {
    // Settled chains remove themselves, so the set only shrinks from here. The catch keeps a
    // rejected queue (no caller can produce one — appends swallow) from racing this loop.
    const pending = Array.from(writers.values(), (queue) => queue.catch(forget))
    await Promise.all(pending)
  }
}

/** Test-only: drops every queued chain, restoring a clean process-wide state. */
export function resetRecordingsForTests(): void {
  writers.clear()
  recentEvents.clear()
  dedupeWindow = 8192
}

/** Test-only: shrinks the dedupe window so eviction is exercisable in milliseconds. */
export function setDedupeWindowForTests(n: number): void {
  dedupeWindow = n
}

/**
 * One line to disk, with the two tolerances the acceptance names.
 *
 * - TORN TAIL: a crash can leave a final line without its newline, and the next append of a
 *   LATER process would glue onto it, losing both lines. The FIRST append of this process to a
 *   file reads the last byte and re-establishes the newline boundary before writing — cheap
 *   because it runs once per recording per process, not per line.
 * - FAILED APPEND: the retry carries its own leading newline, so even an unknown partial state
 *   cannot glue the retried line onto a torn one.
 */
async function appendRecordingLine(path: string, event: string, firstWriteOfProcess: boolean): Promise<void> {
  if (firstWriteOfProcess) {
    // The recordings directory is created lazily by the first write of a process: artifacts
    // pre-create their run dir, but a nested per-agent directory must not cost an mkdir per
    // event, and ensureRunDir cannot know it needs one in advance.
    await mkdir(dirname(path), { recursive: true }).catch(forget)
    // A file left by a previous process can end mid-line: a crash can leave a final line
    // without its newline, and gluing this write onto those bytes would lose both. The first
    // append of THIS process re-establishes the newline boundary instead — cheap because it
    // runs once per recording per process, not per line.
  }
  const boundary = firstWriteOfProcess ? await trailingNewlineMissing(path) : "",
    line = `${boundary}${event}`
  try {
    await appendFile(path, line, "utf8")
  } catch {
    await appendFile(path, `\n${line}`, "utf8").catch(forget)
  }
}

/** `"\\n"` when the file's last byte is a newline, `""` when the file is missing or empty. */
async function trailingNewlineMissing(path: string): Promise<"\n" | ""> {
  try {
    const info = await stat(path)
    if (info.size === 0) {return ""}
    const handle = await open(path, "r")
    try {
      const byte = Buffer.alloc(1)
      await handle.read(byte, 0, 1, info.size - 1)
      // Byte-compared, not string-decoded: the last byte of a torn multibyte character is
      // not a newline whichever way the boundary above resolves.
      return byte[0] === 0x0A ? "" : "\n"
    } finally {
      await handle.close().catch(forget)
    }
  } catch {
    return ""
  }
}

/** The dedupe key: the envelope as delivered, timed out of the picture. */
function serializeEnvelope({ type, properties }: RecordedEvent): string {
  try {
    return JSON.stringify({ type, properties: properties ?? null })
  } catch {
    // Unserializable envelopes are individually unique by construction (the error shape is
    // a constant), but milliseconds apart — dedupe them separately anyway, per event time.
    return JSON.stringify({ type, properties: Date.now() })
  }
}

/**
 * One event per line, verbatim: the envelope the Bus delivered, with its arrival time.
 *
 * The Properties object is written as received — this is what makes the joined lines read as
 * the agent's full part stream, prompt text, tool calls and structured output included (the
 * prompt itself is a part event in the child session). A payload that cannot serialize (the
 * JSON source is trusted, but this seam must never throw) degrades to an error marker line
 * rather than swallowing the whole event: shape survives, bytes would not.
 */
function serializeEvent(event: RecordedEvent): string {
  try {
    return JSON.stringify({ at: Date.now(), type: event.type, properties: event.properties ?? null })
  } catch {
    return JSON.stringify({ at: Date.now(), type: event.type, properties: "<unserializable>" })
  }
}
