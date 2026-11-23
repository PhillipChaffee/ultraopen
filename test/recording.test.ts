import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordAgentEvent, resetRecordingsForTests, settleRecordings } from "../src/server/resume/recording.js"
import { ensureRunDir, recordingPath, recordingsDir } from "../src/server/resume/store.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ChildSessionRecord, LiveRunRecord, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { onV2Event } from "../src/server/runtime/events.js"
import type { V2BusEvent } from "../src/server/runtime/events.js"

/**
 * The V2 agent recording (ADR-0004): every finalized event of an engine-owned child appends one
 * line, `{ at, id, type, data }`, to that agent's JSONL file. Deltas are skipped (they are
 * character noise), duplicates are dropped in O(1) through the coordinator's event-id FIFO, and
 * the writer is best-effort: a torn tail is repaired, a failed append never reaches the host.
 */

let base: string,
  env: NodeJS.ProcessEnv,
  coordinator: RuntimeCoordinator,
  savedXDG: string | undefined

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-recording-"))
  savedXDG = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = base
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
  resetRecordingsForTests()
  resetCoordinatorForTests()
  coordinator = getCoordinator()
})

afterEach(async () => {
  resetRecordingsForTests()
  resetCoordinatorForTests()
  if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
  else {process.env["XDG_DATA_HOME"] = savedXDG}
  await rm(base, { recursive: true, force: true })
})

const childRecord = (runId: string, index = 0, label = "alpha:one"): ChildSessionRecord => ({
  runId,
  projectKey: "project-1",
  parentSessionID: "parent",
  ancestorSessionIDs: [],
  index,
  label,
  lastActivityAt: 0,
  currentAttempt: 0,
})

const spawnChild = (runId: string, index = 0, label = "alpha:one"): string => {
  const sessionID = `ses_child_${runId}_${index}`
  coordinator.registerChild(sessionID, childRecord(runId, index, label))
  return sessionID
}

const event = (sessionID: string, id: string | undefined, type: string, data?: Record<string, unknown>): V2BusEvent => ({
  ...(id === undefined ? {} : { id }),
  type,
  data: { sessionID, ...data },
})

const recordingFile = async (runId: string, index = 0, label = "alpha:one"): Promise<string> =>
  await readFile(recordingPath(runId, index, label, env), "utf8")

const recordingLines = async (runId: string, index = 0, label = "alpha:one"): Promise<string[]> => {
  const text = await recordingFile(runId, index, label)
  return text.split("\n").filter((line) => line !== "")
}

interface RecordedLine {
  at: number
  id: string | null
  type: string
  data: Record<string, unknown>
}

const lineAt = (lines: string[], index: number): RecordedLine => {
  const line = lines[index]
  if (line === undefined) {throw new Error(`recording line ${index} missing`)}
  return JSON.parse(line) as RecordedLine
}

describe("recordAgentEvent", () => {
  test("an owned child's finalized event appends one line with at, id, type and data", async () => {
    const runId = "wf_rec00000001",
      sessionID = spawnChild(runId)
    await ensureRunDir(runId, env)
    recordAgentEvent(event(sessionID, "evt_1", "session.text.ended", { text: "done" }), coordinator, env)
    await settleRecordings()

    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(1)
    const line = lineAt(lines, 0)
    expect(typeof line.at).toBe("number")
    expect(line.id).toBe("evt_1")
    expect(line.type).toBe("session.text.ended")
    expect(line.data["text"]).toBe("done")
  })

  test("a duplicate event id records one line, not two (O(1) coordinator dedupe)", async () => {
    const runId = "wf_rec00000002",
      sessionID = spawnChild(runId)
    await ensureRunDir(runId, env)
    const first = event(sessionID, "evt_dupe", "session.text.ended", { text: "one" })
    recordAgentEvent(first, coordinator, env)
    recordAgentEvent({ ...first, data: { ...first.data } }, coordinator, env)
    await settleRecordings()
    expect(await recordingLines(runId)).toHaveLength(1)

    recordAgentEvent(event(sessionID, "evt_other", "session.text.ended", { text: "two" }), coordinator, env)
    await settleRecordings()
    expect(await recordingLines(runId)).toHaveLength(2)
  })

  test("a foreign session records nothing — not even a file", async () => {
    await ensureRunDir("wf_rec00000003", env)
    recordAgentEvent(event("ses_foreign", "evt_1", "session.text.ended", {}), coordinator, env)
    await settleRecordings()
    expect(await readdirShallow(recordingsDir("wf_rec00000003", env))).toEqual([])
  })

  test("an id-less event still records — dedupe is only possible when the host supplies an id", async () => {
    const runId = "wf_rec00000004",
      sessionID = spawnChild(runId)
    recordAgentEvent(event(sessionID, undefined, "session.tool.success", {}), coordinator, env)
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(1)
    expect(lineAt(lines, 0).id).toBeNull()
  })

  test("two agents of one run land on separate files named by index and label", async () => {
    const runId = "wf_rec00000005",
      first = spawnChild(runId, 0, "alpha:one"),
      second = spawnChild(runId, 1, "schema beta!!")
    await ensureRunDir(runId, env)
    recordAgentEvent(event(first, "evt_a", "session.text.ended", { text: "first" }), coordinator, env)
    recordAgentEvent(event(second, "evt_b", "session.text.ended", { text: "second" }), coordinator, env)
    await settleRecordings()
    expect(await recordingFile(runId, 0, "alpha:one")).toContain("first")
    expect(await recordingFile(runId, 1, "schema beta!!")).toContain("second")
    expect(await recordingFile(runId, 0, "alpha:one")).not.toContain("second")
  })

  test("an unserializable payload degrades to a marker line — the seam never throws", async () => {
    const runId = "wf_rec00000006",
      sessionID = spawnChild(runId)
    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => {
      recordAgentEvent({ id: "evt_1", type: "session.text.ended", data: { sessionID, circular } }, coordinator, env)
    }).not.toThrow()
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(1)
    expect(lineAt(lines, 0).type).toBe("session.text.ended")
  })

  test("the idle restart's new child session records onto the same file as its predecessor", async () => {
    const runId = "wf_rec00000007",
      oldSession = spawnChild(runId, 0, "alpha:one"),
      newSession = "ses_restart_new"
    await ensureRunDir(runId, env)
    recordAgentEvent(event(oldSession, "evt_1", "session.text.ended", {}), coordinator, env)
    coordinator.registerChild(newSession, childRecord(runId, 0, "alpha:one"))
    recordAgentEvent(event(newSession, "evt_2", "session.text.ended", {}), coordinator, env)
    await settleRecordings()
    expect(await recordingLines(runId)).toHaveLength(2)
  })
})

describe("the recording writer's tolerances", () => {
  test("an empty pre-existing file appends straight, with no boundary newline", async () => {
    const runId = "wf_rec00000010",
      sessionID = spawnChild(runId),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(recordingsDir(runId, env), { recursive: true })
    await Bun.write(path, "")
    recordAgentEvent(event(sessionID, "evt_1", "session.text.ended", {}), coordinator, env)
    await settleRecordings()
    expect(await recordingLines(runId)).toHaveLength(1)
  })

  test("an unappendable target never throws: the retry repairs, the second failure is swallowed", async () => {
    const runId = "wf_rec00000011",
      sessionID = spawnChild(runId),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(path, { recursive: true })
    expect(() => {
      recordAgentEvent(event(sessionID, "evt_1", "session.text.ended", {}), coordinator, env)
    }).not.toThrow()
    await settleRecordings()
  })

  test("a torn tail is repaired at the first append of a process", async () => {
    const runId = "wf_rec00000012",
      sessionID = spawnChild(runId),
      path = recordingPath(runId, 0, "alpha:one", env)
    await mkdir(recordingsDir(runId, env), { recursive: true })
    await Bun.write(path, '{"at":1,"id":"a","type":"session.text.ended","data":{}}\n{"at":2,"type":"session.too')
    recordAgentEvent(event(sessionID, "evt_2", "session.tool.success", {}), coordinator, env)
    await settleRecordings()

    const text = await recordingFile(runId),
     lines = text.split("\n")
    const tornIndex = lines.findIndex((line) => line.startsWith('{"at":2,"type":"session.too')),
      appendedIndex = lines.findIndex((line) => line.includes("evt_2"))
    expect(tornIndex).toBeGreaterThanOrEqual(0)
    expect(appendedIndex).toBeGreaterThan(tornIndex)
  })

  test("a missing run directory is self-healed on the first write", async () => {
    const runId = "wf_rec00000013",
      sessionID = spawnChild(runId)
    recordAgentEvent(event(sessionID, "evt_1", "session.text.ended", {}), coordinator, env)
    await settleRecordings()
    expect(await recordingLines(runId)).toHaveLength(1)
  })
})

describe("onV2Event", () => {
  test("character deltas are skipped but still touch activity", async () => {
    const runId = "wf_rec00000020",
      sessionID = spawnChild(runId)
    await ensureRunDir(runId, env)
    onV2Event(event(sessionID, "evt_delta", "session.text.delta", { delta: "a" }), coordinator)
    await settleRecordings()
    expect(await readdirShallow(recordingsDir(runId, env))).toEqual([])
    expect(coordinator.lastActivity(sessionID)).toBeGreaterThan(0)
  })

  test("session.text.ended and session.tool.success record, and a duplicate id records once", async () => {
    const runId = "wf_rec00000021",
      sessionID = spawnChild(runId)
    await ensureRunDir(runId, env)
    onV2Event(event(sessionID, "evt_text", "session.text.ended", { text: "done" }), coordinator)
    onV2Event(event(sessionID, "evt_tool", "session.tool.success", {}), coordinator)
    onV2Event(event(sessionID, "evt_text", "session.text.ended", { text: "done" }), coordinator)
    await settleRecordings()
    const lines = await recordingLines(runId)
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => lineAt([line], 0).type)).toEqual(["session.text.ended", "session.tool.success"])
  })

  test("agent and permission changes notify every affected owned child", () => {
    const runId = "wf_rec00000022",
      sessionID = spawnChild(runId)
    coordinator.runs.set(runId, liveRun(runId, "parent"))
    const changed: string[] = []
    onV2Event(event("parent", "evt_agent", "session.agent.selected", { agent: "plan" }), coordinator, (id) => changed.push(id))
    expect(changed).toEqual([sessionID])
    changed.length = 0
    onV2Event(event("parent", "evt_perm", "session.permissions", { permissions: [] }), coordinator, (id) => changed.push(id))
    expect(changed).toEqual([sessionID])
    changed.length = 0
    onV2Event({ id: "evt_config", type: "config.updated", data: {} }, coordinator, (id) => changed.push(id))
    expect(changed).toEqual([sessionID])
    changed.length = 0
    // An agent DEFINITION change carries no session id: every owned child re-checks its chain.
    onV2Event({ id: "evt_agent_def", type: "agent.updated", data: {} }, coordinator, (id) => changed.push(id))
    expect(changed).toEqual([sessionID])
  })

  test("a foreign session is never touched or recorded", async () => {
    const changed: string[] = []
    onV2Event(event("ses_foreign", "evt_1", "session.text.ended", {}), coordinator, (id) => changed.push(id))
    await settleRecordings()
    expect(coordinator.lastActivity("ses_foreign")).toBe(0)
    expect(changed).toEqual([])
  })
})

const liveRun = (runId: string, sessionID: string): LiveRunRecord => ({
  runId,
  sessionID,
  projectKey: "project-1",
  locationDir: "/work",
  status: "running",
  startedAt: 1,
})

async function readdirShallow(dir: string): Promise<string[]> {
  return await readdir(dir).catch((): string[] => [])
}
