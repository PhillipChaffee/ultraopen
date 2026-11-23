import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resumeInterruptedRuns } from "../src/server/resume/autoresume.js"
import { appendJournal, artifactPaths, ensureRunDir, readManifest, writeManifest, writeScript } from "../src/server/resume/store.js"
import { argsHash } from "../src/server/resume/key.js"
import { resolveOptions } from "../src/server/options.js"
import { CONTROL_STOP_ABORT_REASON, STOP_ABORT_REASON, liveRunsForSession, settlePromiseOf } from "../src/server/tool/background.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import type { HostAgentInfo, HostPort, HostSessionInfo } from "../src/server/host/port.js"
import type { execute, WorkflowArgs, WorkflowContext, WorkflowResult } from "../src/server/tool/workflow.js"
import type { JournalEntry, Manifest } from "../src/server/resume/journal.js"

/**
 * The boot-time auto-resume sweep, against seeded on-disk runs.
 *
 * The engine is injected (`executeFn`): the sweep's own decisions — project scoping, guards,
 * claim, re-stamp, wiring — are what these tests pin. Adoption additionally requires the parent
 * session AND its agent to be resolvable, so a run whose permissions can no longer be rebuilt is
 * left orphaned instead of executing half-inherited (`#149` #7).
 */

let base: string,
 env: NodeJS.ProcessEnv,
 coordinator: RuntimeCoordinator

const RUN_ID = "wf_resume01",
 SESSION = "ses_orig1",
 SCRIPT = "export const meta = { name: 'e2e-resume', description: 'resume me' }\nreturn 'ok'\n"

beforeEach(async () => {
  resetCoordinatorForTests()
  coordinator = getCoordinator()
  base = await mkdtemp(join(tmpdir(), "ultraopen-autoresume-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
})

afterEach(async () => {
  await chmod(join(base, "opencode", "tool-output", "ultraopen", RUN_ID), 0o700).catch((): undefined => undefined)
  await chmod(join(base, "opencode", "tool-output", "ultraopen", RUN_ID, "manifest.json"), 0o600).catch((): undefined => undefined)
  await rm(base, { recursive: true, force: true })
})

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  runId: RUN_ID,
  bootId: "old-boot",
  pid: 999_999,
  sessionID: SESSION,
  projectID: "project-1",
  directory: "/work",
  sourceHash: "s",
  argsHash: argsHash({ a: 1 }),
  args: { a: 1 },
  status: "orphaned",
  childSessionIDs: [],
  startedAt: Date.now() - 60_000,
  endedAt: Date.now() - 30_000,
  ...overrides,
})

const journalEntry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  type: "result",
  key: "v1:first-call",
  scopePath: "root",
  ordinal: 0,
  label: "first",
  status: "ok",
  value: "cached",
  outputTokens: 5,
  ...overrides,
})

/** Seeds a complete interrupted run: orphaned manifest, script, optional journal, hint marker. */
const seedCandidate = async (
  overrides: Partial<Manifest> = {},
  entries: JournalEntry[] = [],
  options: { omitProject?: boolean } = {},
): Promise<Manifest> => {
  const entry = manifest(overrides)
  if (options.omitProject === true) {delete entry.projectID}
  await ensureRunDir(entry.runId, env)
  await writeManifest(entry.runId, entry, env)
  await writeScript(entry.runId, SCRIPT, env)
  if (entries.length > 0) {await appendJournal(entry.runId, entries.map((e) => JSON.stringify(e)).join("\n"), env)}
  await writeFile(join(artifactPaths(entry.runId, env).dir, "interrupted.txt"), entry.runId, "utf8")
  return entry
}

interface FakeHostOptions {
  sessionGone?: boolean
  sessionRejects?: boolean
  sessionProjectID?: string
  /** The parent session's native `parentID`, for the ancestor-propagation contract. */
  sessionParentID?: string
  sessionAgent?: string
  agentless?: boolean
  agentMissing?: boolean
  agentRejects?: boolean
  /** The catalog `listAgents` reports; defaults to empty (an unresolvable default agent). */
  agents?: HostAgentInfo[]
  /** Makes `listAgents` reject, proving the default-agent fallback fails closed. */
  listAgentsRejects?: boolean
  /** The host's own project location; defaults to the fake `/work` project. */
  location?: { directory: string; canonical: string; projectID: string }
}

interface FakeHost {
  host: HostPort
  synthetic: { id: string; sessionID: string; text: string }[]
}

const makeHost = (options: FakeHostOptions = {}): FakeHost => {
  const synthetic: { id: string; sessionID: string; text: string }[] = []
  const session = (sessionID: string): HostSessionInfo => ({
    id: sessionID,
    projectID: options.sessionProjectID ?? "project-1",
    directory: "/work",
    ...(sessionID === SESSION && options.sessionParentID !== undefined ? { parentID: options.sessionParentID } : {}),
    ...(options.agentless === true ? {} : { agent: options.sessionAgent ?? "build" }),
    outputTokens: 0,
  })
  const host: HostPort = {
    location: options.location ?? { directory: "/work", canonical: "/canonical/work", projectID: "project-1" },
    defaultModel: () => Promise.resolve(undefined),
    listModels: () => Promise.resolve([]),
    getSession: (sessionID) => {
      if (options.sessionRejects === true) {return Promise.reject(new Error("transport down"))}
      if (options.sessionGone === true) {return Promise.resolve(undefined)}
      return Promise.resolve(session(sessionID))
    },
    getAgent: (agentID) => {
      if (options.agentRejects === true) {return Promise.reject(new Error("transport down"))}
      if (options.agentMissing === true) {return Promise.resolve(undefined)}
      return Promise.resolve({ id: agentID, mode: "primary", hidden: false, permissions: [] })
    },
    listAgents: () => {
      if (options.listAgentsRejects === true) {return Promise.reject(new Error("catalog down"))}
      return Promise.resolve(options.agents ?? [])
    },
    listPendingPermissions: () => Promise.resolve([]),
    rejectPermission: () => Promise.resolve(),
    createChildSession: () => Promise.resolve({ ok: true, sessionID: "child-created" }),
    moveSession: () => Promise.resolve({ ok: true }),
    runTurn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "", outputTokens: 0 } }),
    interruptSession: () => Promise.resolve(true),
    admitSynthetic: (input) => {
      synthetic.push({ id: input.id, sessionID: input.sessionID, text: input.text })
      return Promise.resolve("admitted")
    },
  }
  return { host, synthetic }
}

interface ExecuteCall {
  args: WorkflowArgs
  context: WorkflowContext
  /** The manifest as the engine saw it — proving the re-stamp landed BEFORE execution. */
  manifestAtCall: Manifest | undefined
  /** The live-run reminder's title view while the run is live (#142). */
  reminderTitle: string | undefined
}

/** A fake engine that records its inputs and completes the run. */
const makeExecute = (): { fn: typeof execute; calls: ExecuteCall[] } => {
  const calls: ExecuteCall[] = []
  const fn = async (args: WorkflowArgs, context: WorkflowContext): Promise<WorkflowResult> => {
    const atCall = await readManifest(RUN_ID, env)
    calls.push({
      args,
      context,
      manifestAtCall: atCall,
      reminderTitle: liveRunsForSession(context.coordinator, SESSION).at(0)?.title,
    })
    return {
      runId: RUN_ID,
      meta: { name: "e2e-resume", description: "resume me" },
      value: "ok",
      agentCount: 2,
      nulls: [],
      logs: [],
      outputTokens: 7,
      journal: [{ ...journalEntry(), replayed: true, sourceRunId: RUN_ID }],
      childSessionIDs: ["child-x"],
    }
  }
  return { fn, calls }
}

const dirOf = (runId: string): string => artifactPaths(runId, env).dir
const markerOf = (runId: string): string => join(dirOf(runId), "interrupted.txt")
const readMarker = (runId: string): Promise<string> => readFile(markerOf(runId), "utf8")
const statusAt = async (runId: string, atEnv: NodeJS.ProcessEnv = env): Promise<Manifest["status"] | undefined> => {
  const current = await readManifest(runId, atEnv)
  return current?.status
}

const statusOf = async (runId: string): Promise<string | undefined> => await statusAt(runId, env)

const makeProject = (raw: unknown = {}): ProjectRuntime =>
  coordinator.projectOf(
    { directory: "/work", project: { id: "project-1", canonical: "/canonical/work" } },
    resolveOptions(raw),
  )

interface Deps {
  options: Parameters<typeof resumeInterruptedRuns>[3]
}

const deps = (overrides: Partial<Deps["options"]> = {}): Deps => {
  const { fn } = makeExecute()
  return {
    options: {
      bootId: "current-boot",
      candidates: [],
      env,
      isProcessAlive: () => false,
      executeFn: fn,
      ...overrides,
    },
  }
}

describe("resumeInterruptedRuns", () => {
  test("adopts an interrupted run from its journal and hydrates the original session", async () => {
    const entries = [journalEntry()],
     entry = await seedCandidate({}, entries),
     { host, synthetic } = makeHost(),
     { fn, calls } = makeExecute(),
     notes: string[] = [],
     project = makeProject()

    const result = await resumeInterruptedRuns(host, project, coordinator, {
      ...deps({ executeFn: fn }).options,
      candidates: [entry],
      onNote: (note) => notes.push(note),
    })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })

    await settlePromiseOf(coordinator, RUN_ID)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.context.runId).toBe(RUN_ID)
    expect(calls[0]?.context.sessionID).toBe(SESSION)
    expect(calls[0]?.context.host).toBe(host)
    expect(calls[0]?.context.project).toBe(project)
    expect(calls[0]?.context.coordinator).toBe(coordinator)
    expect(calls[0]?.args.args).toEqual({ a: 1 })
    expect(calls[0]?.args.script).toBe(SCRIPT)
    expect(calls[0]?.context.previousEntries).toEqual(entries)
    expect(calls[0]?.context.resumedFrom).toBe(RUN_ID)

    // The re-stamp landed BEFORE the engine ran: live again under THIS boot's identity.
    expect(calls[0]?.manifestAtCall?.status).toBe("running")
    expect(calls[0]?.manifestAtCall?.bootId).toBe(coordinator.processBootId)
    expect(calls[0]?.manifestAtCall?.pid).toBe(process.pid)
    expect(calls[0]?.manifestAtCall?.endedAt).toBeUndefined()

    expect(await statusOf(RUN_ID)).toBe("completed")
    expect(synthetic).toHaveLength(1)
    expect(synthetic[0]?.sessionID).toBe(SESSION)
    expect(synthetic[0]?.id).toBe(`msg_ultraopen_outcome_${RUN_ID}`)
    expect(synthetic[0]?.text).toContain(`<workflow-completed run="${RUN_ID}"`)
    expect(synthetic[0]?.text).toContain(`${RUN_ID} was interrupted when opencode exited; it has been resumed — 1 agent(s) replayed from the journal`)

    await expect(readMarker(RUN_ID)).rejects.toThrow()
    expect(notes).toEqual([`ultraopen: resuming ${RUN_ID} — interrupted when opencode exited`])
    expect(liveRunsForSession(coordinator, SESSION)).toEqual([])
  })

  test("resumeInterruptedRuns propagates parent native ancestorSessionIDs into the resumed detached run", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ sessionParentID: "grandparent" }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, {
      ...deps({ executeFn: fn }).options,
      candidates: [entry],
    })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })
    await settlePromiseOf(coordinator, RUN_ID)
    // The resumed run's children must record the SAME native ancestry the launch would have:
    // the permission walk rebuilds the chain from it after a restart.
    expect(calls[0]?.context.ancestorSessionIDs).toEqual(["grandparent"])
  })

  test("the adopted run's reminder carries the manifest's title (#142)", async () => {
    const entry = await seedCandidate({ title: "Fix the login bug" }),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls[0]?.reminderTitle).toBe("Fix the login bug")
  })

  test("a hand-edited non-string title degrades to untitled at the registry (#142)", async () => {
    const entry = await seedCandidate({ title: 42 as unknown as string }),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls[0]?.reminderTitle).toBeUndefined()
  })

  test.each([
    ["whitespace-only", "   "],
    ["null decoration", "null"],
  ])("a hand-edited %s title is absent at the registry (#142)", async (_label, blank) => {
    const entry = await seedCandidate({ title: blank }),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls[0]?.reminderTitle).toBeUndefined()
  })

  test("ignores a run belonging to a different project", async () => {
    const entry = await seedCandidate({ projectID: "project-2" }),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("adopts a run whose project id differs but whose recorded directory aliases this host's root (T12)", async () => {
    // V2 mints a project id from the directory string. The same checkout reached through
    // /var/... and /private/var/... (or a symlinked worktree) yields two ids; the recorded
    // directory resolving to this host's canonical root is the SAME project.
    const projectDir = join(base, "project"),
     aliasDir = join(base, "project-alias")
    await mkdir(projectDir, { recursive: true })
    await symlink(projectDir, aliasDir)
    const entry = await seedCandidate({ projectID: "project-from-the-alias", directory: aliasDir }),
     { host } = makeHost({ location: { directory: projectDir, canonical: projectDir, projectID: "project-from-the-other-alias" } }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls).toHaveLength(1)
    expect(await statusOf(RUN_ID)).toBe("completed")
  })

  test("still refuses a run whose recorded directory is a genuinely different project", async () => {
    const projectDir = join(base, "project"),
     otherDir = join(base, "other-project")
    await mkdir(projectDir, { recursive: true })
    await mkdir(otherDir, { recursive: true })
    const entry = await seedCandidate({ projectID: "some-other-project", directory: otherDir }),
     { host } = makeHost({ location: { directory: projectDir, canonical: projectDir, projectID: "this-project" } }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("a directory-alias candidate still needs its parent session (#149 #7)", async () => {
    const projectDir = join(base, "project")
    await mkdir(projectDir, { recursive: true })
    const entry = await seedCandidate({ projectID: "other-project", directory: projectDir }),
     { host } = makeHost({ sessionGone: true, location: { directory: projectDir, canonical: projectDir, projectID: "this-project" } }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("a directory-alias candidate still needs its parent agent (#149 #7)", async () => {
    const projectDir = join(base, "project")
    await mkdir(projectDir, { recursive: true })
    const entry = await seedCandidate({ projectID: "other-project", directory: projectDir }),
     { host } = makeHost({ agentMissing: true, location: { directory: projectDir, canonical: projectDir, projectID: "this-project" } }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("an unscoped manifest falls back to the live session's project", async () => {
    const entry = await seedCandidate({}, [], { omitProject: true }),
     { host } = makeHost({ sessionProjectID: "project-2" }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
  })

  test("skips a run whose interruption is older than the TTL window", async () => {
    const entry = await seedCandidate({ endedAt: Date.now() - 72 * 60 * 60 * 1000 }),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("honors the autoResume opt-out", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject({ autoResume: false }), coordinator, {
      ...deps({ executeFn: fn }).options,
      candidates: [entry],
    })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
  })

  test("skips a run whose stored args no longer match the manifest hash", async () => {
    const entry = await seedCandidate({ argsHash: argsHash({ a: 999 }) }),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("adopts a hydrated run: the stored args pass the same boundary the launch used (#78)", async () => {
    const entry = await seedCandidate({
      args: { repo: "dot-agents-alignment" },
      argsHash: argsHash({ repo: "dot-agents-alignment" }),
      argsRawString: '{"repo":"dot-agents-alignment"}',
    }),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls[0]?.args.args).toEqual({ repo: "dot-agents-alignment" })
    const after = await readManifest(RUN_ID, env)
    expect(after?.argsRawString).toBe('{"repo":"dot-agents-alignment"}')
    expect(after?.argsHash).toBe(argsHash({ repo: "dot-agents-alignment" }))
  })

  test("skips a pre-hydration manifest whose stored args is the raw stringified payload", async () => {
    const raw = '{"repo":"dot-agents-alignment"}',
     entry = await seedCandidate({ args: raw, argsHash: argsHash(raw) }),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("skips a run whose original session no longer exists", async () => {
    const entry = await seedCandidate(),
     { host, synthetic } = makeHost({ sessionGone: true }),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
    expect(synthetic).toEqual([])
  })

  test("refuses adoption when the parent session has no resolvable agent (#149 #7)", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ agentless: true }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("adopts when the parent session names no agent but the host's default primary resolves (T12)", async () => {
    // V2 stores `session.agent` as optional; a plain `opencode run` session leaves it unset and
    // the permission chain falls back to the default primary. Auto-resume must resolve that same
    // agent instead of orphaning a replayable journal.
    const entry = await seedCandidate(),
     { host } = makeHost({ agentless: true, agents: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls).toHaveLength(1)
    expect(await statusOf(RUN_ID)).toBe("completed")
  })

  test("the default-agent fallback takes a visible primary when no build agent exists", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({
       agentless: true,
       agents: [
         { id: "helper", mode: "subagent", hidden: false, permissions: [] },
         { id: "planner", mode: "primary", hidden: false, permissions: [] },
       ],
     }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(calls).toHaveLength(1)
  })

  test("a session naming no agent still fails closed when the catalog resolves no primary", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ agentless: true, agents: [{ id: "ghost", mode: "subagent", hidden: true, permissions: [] }] }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("a catalog failure naming no agent fails closed and keeps the hint", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ agentless: true, listAgentsRejects: true }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("a session lookup failure fails closed and keeps the hint", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ sessionRejects: true }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("an agent lookup failure fails closed and keeps the hint", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ agentRejects: true }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("refuses adoption when the parent agent is not in the catalog (#149 #7)", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost({ sessionAgent: "ghost", agentMissing: true }),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("skips a run whose children recorded a stop request", async () => {
    const stoppedEntry: JournalEntry = { ...journalEntry(), status: "null", reason: "aborted", detail: STOP_ABORT_REASON },
     entry = await seedCandidate({}, [stoppedEntry]),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("skips a run whose children recorded the control channel's stop request", async () => {
    const stoppedEntry: JournalEntry = { ...journalEntry(), status: "null", reason: "aborted", detail: CONTROL_STOP_ABORT_REASON },
     entry = await seedCandidate({}, [stoppedEntry]),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("never adopts a run whose recorded pid is still alive", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, {
      ...deps({ executeFn: fn, isProcessAlive: () => true }).options,
      candidates: [entry],
    })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("caps adoptions per boot, oldest interruption first", async () => {
    const older = await seedCandidate({ runId: "wf_older001", startedAt: Date.now() - 60_000 }),
     newer = await seedCandidate({ runId: "wf_newer001", startedAt: Date.now() - 10_000 }),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject({ autoResumeMax: 1 }), coordinator, {
      ...deps({ executeFn: fn }).options,
      candidates: [newer, older],
    })
    expect(result).toEqual({ resumed: ["wf_older001"], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.context.runId).toBe("wf_older001")
    expect(await statusOf("wf_newer001")).toBe("orphaned")
    expect(await readMarker("wf_newer001")).toBe("wf_newer001")
    await settlePromiseOf(coordinator, "wf_older001")
  })

  test("cannot adopt a run whose hint marker is already claimed", async () => {
    const entry = await seedCandidate()
    await rm(markerOf(RUN_ID))
    const { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
  })

  test("a failed adoption leaves the hint and the orphaned record intact", async () => {
    const entry = await seedCandidate()
    await chmod(dirOf(RUN_ID), 0o500)
    const { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 0, failed: 1 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("a corrupt persisted script keeps the run orphaned with its hint", async () => {
    const entry = await seedCandidate()
    await writeScript(RUN_ID, "const const const", env)
    const { host } = makeHost(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
  })

  test("a resumed run that fails still hydrates the interrupted story", async () => {
    const entry = await seedCandidate(),
     { host, synthetic } = makeHost(),
     fn = ((): Promise<never> => Promise.reject(new Error("engine exploded"))) as unknown as typeof execute

    await resumeInterruptedRuns(host, makeProject(), coordinator, { ...deps({ executeFn: fn }).options, candidates: [entry] })
    await settlePromiseOf(coordinator, RUN_ID)

    expect(await statusOf(RUN_ID)).toBe("failed")
    expect(synthetic).toHaveLength(1)
    expect(synthetic[0]?.text).toContain(`<workflow-failed run="${RUN_ID}"`)
    expect(synthetic[0]?.text).toContain(`${RUN_ID} was interrupted when opencode exited; it has been resumed — 0 agent(s) replayed from the journal`)
    expect(await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")).toContain("engine exploded")
  })

  test("a throwing note sink never breaks the sweep", async () => {
    const entry = await seedCandidate(),
     { host } = makeHost(),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns(host, makeProject(), coordinator, {
      ...deps({ executeFn: fn }).options,
      candidates: [entry],
      onNote: () => {
        throw new Error("hostile sink")
      },
    })
    expect(result).toEqual({ resumed: [], skipped: 0, failed: 1 })
    expect(calls).toHaveLength(0)
  })

  test("saved-workflow scan notes ride the sweep's own note sink", async () => {
    const brokenDir = join(base, "workflows")
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, "broken.js"), "const const const", "utf8")
    const entry = await seedCandidate(),
     notes: string[] = [],
     { host } = makeHost(),
     { fn } = makeExecute()

    await resumeInterruptedRuns(host, makeProject({ workflowPaths: [brokenDir] }), coordinator, {
      ...deps({ executeFn: fn }).options,
      candidates: [entry],
      onNote: (note) => notes.push(note),
    })
    await settlePromiseOf(coordinator, RUN_ID)
    expect(notes.some((note) => note.includes("broken"))).toBe(true)
  })
})
