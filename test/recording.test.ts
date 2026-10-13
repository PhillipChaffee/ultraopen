import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordAgentEvent, resetRecordingsForTests, setDedupeWindowForTests, settleRecordings } from "../src/server/resume/recording.js"
import { ensureRunDir, recordingPath, recordingsDir } from "../src/server/resume/store.js"
import { registry } from "../src/server/singleton.js"

/**
 * The agent recording's write tests (#150).
 *
 * The acceptance seams in miniature: append-only (one event, one line, never coalesced),
 * foreign sessions recorded nowhere, same-session events on one file in arrival order, and a
 * torn tail re-establishing its newline boundary at the first write of a process — so a
 * crash's damage is one partial line's bytes, never a recording whose reader must parse
 * garbage mid-file.
 */

let base: string,
  env: NodeJS.ProcessEnv

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-recording-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
  resetRecordingsForTests()
  registry.resetForTests()
})

afterEach(async () => {
  resetRecordingsForTests()
  registry.resetForTests()
  await rm(base, { recursive: true, force: true })
})

/** One engine-owned child, registered the way the live engine does: with its identity. */
const spawnChild = (runId: string, index = 0, label = "alpha:one"): string => {
  const sessionID = `ses_child_${runId}_${index}`
  registry.register(sessionID, runId, { index, label })
  return sessionID
}

const recordingFile = async (runId: string, index = 0, label = "alpha:one"): Promise<string> =>
  await readFile(recordingPath(runId, index, label, env), "utf8")

/** The recording's line array, with blank separators dropped. */
const recordingLines = async (runId: string, index = 0, label = "alpha:one"): Promise<string[]> => {
  const text = await recordingFile(runId, index, label)
  return text.split("\n").filter((line) => line !== "")
}

/** One recorded line, decoded: the envelope the capture seam writes. */
const lineOf = (line: string): { at: number; type: string; properties: { part?: { sessionID: string; text?: string } } } =>
  JSON.parse(line)

/** The i-th line of a split recording, asserted present — index access stays unindexed. */
const lineAt = (lines: string[], i: number): string => {
  const line = lines[i]
  if (line === undefined) {throw new Error(`recording line ${i} missing`)}
  return line
}

describe("capture", () => {
  test("an engine-owned child's events append one line per event, in arrival order", async () => {
    const runId = "wf_rec00000001",
      sessionID = spawnChild(runId, 0, "alpha:one")
    await ensureRunDir(runId, env)
    recordAgentEvent(sessionID, { type: "message.part.updated", properties: { part: { sessionID, text: "prompt" } } }, env)
    await settleRecordings()
    recordAgentEvent(sessionID, { type: "message.part.updated", properties: { part: { sessionID, text: "part two" } } }, env)
    await settleRecordings()

    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(2)
    const first = lineOf(lineAt(lines, 0))
    expect(first.type).toBe("message.part.updated")
    expect(first.properties["part"]?.text).toBe("prompt")
    // Two strings, two lines: NOTHING coalesces — an event that arrived is on disk.
    expect(lineAt(lines, 1)).toContain("part two")
    expect(lineAt(lines, 1)).not.toBe(lineAt(lines, 0))
  })

  test("a foreign session records nothing — not even a file", async () => {
    await ensureRunDir("wf_rec00000002", env)
    recordAgentEvent("ses_foreign", { type: "message.part.updated", properties: {} }, env)
    await settleRecordings()
    const files = await readdirShallow(recordingsDir("wf_rec00000002", env))
    expect(files).toEqual([])
  })

  test("a session registered without an agent identity records nothing", async () => {
    // The registry's narrow historical callers still register — but without index+label the
    // recording's name is undecidable, so the honest answer is no recording, not a guess.
    await ensureRunDir("wf_rec00000003", env)
    registry.register("ses_identity_free", "wf_rec00000003")
    recordAgentEvent("ses_identity_free", { type: "message.part.updated", properties: {} }, env)
    await settleRecordings()
    expect(await readdirShallow(recordingsDir("wf_rec00000003", env))).toEqual([])
  })

  test("recordings for two agents of one run land on separate files named by index and label", async () => {
    const runId = "wf_rec00000004",
      first = spawnChild(runId, 0, "alpha:one"),
      second = spawnChild(runId, 1, "schema beta!!")
    await ensureRunDir(runId, env)
    recordAgentEvent(first, { type: "message.part.updated", properties: { part: { sessionID: first, text: "first" } } }, env)
    recordAgentEvent(second, { type: "message.part.updated", properties: { part: { sessionID: second, text: "second" } } }, env)
    await settleRecordings()
    expect(await recordingFile(runId, 0, "alpha:one")).toContain("first")
    expect(await recordingFile(runId, 1, "schema beta!!")).toContain("second")
    expect(await recordingFile(runId, 0, "alpha:one")).not.toContain("second")
  })

  test("an unserializable payload degrades to a marker line — the seam never throws", async () => {
    const runId = "wf_rec00000010",
      sessionID = spawnChild(runId, 0, "alpha:one")
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => recordAgentEvent(sessionID, { type: "message.part.updated", properties: circular }, env)).not.toThrow()
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(1)
    expect(lineOf(lineAt(lines, 0)).type).toBe("message.part.updated")
  })

  test("an empty pre-existing file appends straight, with no boundary newline", async () => {
    const runId = "wf_rec00000011",
      sessionID = spawnChild(runId, 0, "alpha:one"),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(recordingsDir(runId, env), { recursive: true })
    await Bun.write(path, "")
    recordAgentEvent(sessionID, { type: "message.part.updated", properties: { part: { sessionID } } }, env)
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(1)
  })

  test("an unappendable target never throws: the retry repairs, the second failure is swallowed", async () => {
    // The recording path is occupied by a DIRECTORY: the plain append fails, the newline-
    // prefixed retry fails too, and the hook still survives — the file's absence must never
    // break the run (ADR-0004).
    const runId = "wf_rec00000012",
      sessionID = spawnChild(runId, 0, "alpha:one"),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(path, { recursive: true })
    expect(() => recordAgentEvent(sessionID, { type: "message.part.updated", properties: { part: { sessionID } } }, env)).not.toThrow()
    await settleRecordings()
  })

  test("the dedupe window is a window, not a ledger: eviction frees old keys and keeps new events", async () => {
    setDedupeWindowForTests(4)
    try {
      const runId = "wf_rec00000013",
        sessionID = spawnChild(runId, 0, "alpha:one"),
        dup = (id: number): { type: string; properties: Record<string, unknown> } => ({
          type: "message.part.updated",
          properties: { part: { sessionID, rev: id } },
        })
      for (let i = 0; i < 6; i++) {
        recordAgentEvent(sessionID, dup(1), env)
        recordAgentEvent(sessionID, dup(i + 10), env)
      }
      await settleRecordings()
      // Six DISTINCT envelopes record (eviction never ate a live event); the dup(1) repeats
      // dedupe only while its digest is inside the 4-entry window — i=1..3 skip it, then its
      // eviction frees another record at i=4, and i=5 dedupes again. A window's semantics.
      const events = await recordingLines(runId)
      // dup(10..15) = 6, plus dup(1) at i=0 and again at i=4.
      expect(events).toHaveLength(8)
    } finally {
      resetRecordingsForTests()
    }
  })

  test("a torn tail is repaired at the first append of a process: the boundary line stays before it", async () => {
    // A crash mid-write left a final line without its newline and (harmfully) bytes of a
    // second event. The first append of THIS process must not glue onto those bytes.
    const runId = "wf_rec00000005",
      sessionID = spawnChild(runId, 0, "alpha:one"),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(recordingsDir(runId, env), { recursive: true })
    await Bun.write(path, '{"at":1,"type":"message.part.updated","properties":{}}\n{"at":2,"type":"message.par')
    recordAgentEvent(sessionID, { type: "message.updated", properties: { info: { sessionID } } }, env)
    await settleRecordings()

    const text = await recordingFile(runId),
      lines = text.split("\n")
    const tornIndex = lines.findIndex((line) => line.startsWith('{"at":2,"type":"message.par')),
      appendedIndex = lines.findIndex((line) => line.includes("message.updated"))
    // The torn remnant stays (append-only: no line is ever rewritten), but the appended event
    // begins on its own line — the newline boundary is re-established, not assumed.
    expect(tornIndex).toBeGreaterThanOrEqual(0)
    expect(appendedIndex).toBeGreaterThan(tornIndex)
    const appended = lineOf(lineAt(lines, appendedIndex))
    expect(appended.type).toBe("message.updated")
  })

  test("a newline-terminated file from a previous process appends straight, no boundary line inserted", async () => {
    const runId = "wf_rec00000006",
      sessionID = spawnChild(runId, 0, "alpha:one"),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(recordingsDir(runId, env), { recursive: true })
    await Bun.write(path, '{"at":1,"type":"message.part.updated","properties":{}}\n')
    recordAgentEvent(sessionID, { type: "message.updated", properties: {} }, env)
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(2)
    expect(lineOf(lineAt(lines, 1)).type).toBe("message.updated")
  })

  test("the recording writes never throw, and a missing run directory is self-healed on the first write", async () => {
    // The launch path always creates the run dir before a child can spawn, but the writer
    // does not lean on that: its lazy mkdir -p walks the whole path, so an event that arrives
    // lands on disk after the write cycle however the earlier setup fared, and nothing here
    // throws either way — the hook would kill the server on a rejection.
    const sessionID = spawnChild("wf_rec00000007", 0, "alpha:one")
    expect(() => recordAgentEvent(sessionID, { type: "message.part.updated", properties: { part: { sessionID } } }, env)).not.toThrow()
    await settleRecordings()
    const lines = await recordingLines("wf_rec00000007")
    expect(lines).toHaveLength(1)
    expect(lineOf(lineAt(lines, 0)).type).toBe("message.part.updated")
  })

  test("a second hooking of the same event records one line, not two (per-directory plugin copies)", async () => {
    // opencode instantiates the plugin once per directory, so the root instance and a
    // worktree child's instance can both see the same Bus event in one process. touchActivity
    // deduped by idempotent map writes; the recording dedupes by envelope.
    const runId = "wf_rec00000009",
      sessionID = spawnChild(runId, 0, "alpha:one")
    await ensureRunDir(runId, env)
    const envelope = { type: "message.part.updated", properties: { part: { sessionID, id: "prt_1" } } }
    recordAgentEvent(sessionID, envelope, env)
    recordAgentEvent(sessionID, { ...envelope }, env)
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(1)
    // A genuinely different event right after still records — the window is per-envelope.
    recordAgentEvent(sessionID, { type: "message.part.updated", properties: { part: { sessionID, id: "prt_2" } } }, env)
    await settleRecordings()
    const after = await recordingLines(runId)
    expect(after).toHaveLength(2)
  })

  test("the idle restart's new child session records onto the same file as its predecessor", async () => {
    // A stall restart spawns a NEW session but is the same agent call — same key, same file.
    const runId = "wf_rec00000008",
      oldSession = spawnChild(runId, 0, "alpha:one"),
      newSession = "ses_restart_new"
    // Room for the old line, then the restart lands in one just-registered new session.
    await ensureRunDir(runId, env)
    recordAgentEvent(oldSession, { type: "message.part.updated", properties: { part: { sessionID: oldSession } } }, env)
    registry.register(newSession, runId, { index: 0, label: "alpha:one" })
    recordAgentEvent(newSession, { type: "message.part.updated", properties: { part: { sessionID: newSession } } }, env)
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(2)
    // Arrival order holds across the identity swap: old child before new one.
    expect(lineOf(lineAt(lines, 0)).properties["part"]?.sessionID).toBe(oldSession)
    expect(lineOf(lineAt(lines, 1)).properties["part"]?.sessionID).toBe(newSession)
  })
})

/** Readdir of a directory that may not exist, tolerantly like every e2e-adjacent helper. */
async function readdirShallow(dir: string): Promise<string[]> {
  return await readdir(dir).catch(() => [])
}
