import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resumeInterruptedRuns } from "../src/server/resume/autoresume.js"
import { appendJournal, artifactPaths, ensureRunDir, readManifest, writeManifest, writeScript } from "../src/server/resume/store.js"
import { argsHash } from "../src/server/resume/key.js"
import { resolveOptions } from "../src/server/options.js"
import { STOP_ABORT_REASON, liveRunsForSession, resetForTests, settlePromiseOf } from "../src/server/tool/background.js"
import { registry } from "../src/server/singleton.js"
import type { execute, WorkflowArgs, WorkflowContext, WorkflowResult } from "../src/server/tool/workflow.js"
import type { JournalEntry, Manifest } from "../src/server/resume/journal.js"
import type { OpencodeClient } from "../src/server/types.js"

/**
 * The boot-time auto-resume sweep, against seeded on-disk runs.
 *
 * The engine is injected (executeFn): the sweep's own decisions — guards, claim, re-stamp,
 * wiring — are what these tests pin, and the real engine's behavior under resume is covered by
 * the run/resume suites plus the e2e kill-and-relaunch case.
 */

let base: string,
 env: NodeJS.ProcessEnv

const RUN_ID = "wf_resume01",
 SESSION = "ses_orig1",
 SCRIPT = "export const meta = { name: 'e2e-resume', description: 'resume me' }\nreturn 'ok'\n"

beforeEach(() => {
  registry.resetForTests()
  resetForTests()
})

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-autoresume-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
})

afterEach(async () => {
  await chmod(join(base, "opencode", "tool-output", "ultraopen", RUN_ID, "manifest.json"), 0o600).catch(() => undefined)
  await rm(base, { recursive: true, force: true })
})

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  runId: RUN_ID,
  bootId: "old-boot",
  pid: 999_999,
  sessionID: SESSION,
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
const seedCandidate = async (overrides: Partial<Manifest> = {}, entries: JournalEntry[] = []): Promise<Manifest> => {
  const entry = manifest(overrides)
  await ensureRunDir(entry.runId, env)
  await writeManifest(entry.runId, entry, env)
  await writeScript(entry.runId, SCRIPT, env)
  if (entries.length > 0) {await appendJournal(entry.runId, entries.map((e) => JSON.stringify(e)).join("\n"), env)}
  await writeFile(join(artifactPaths(entry.runId, env).dir, "interrupted.txt"), entry.runId, "utf8")
  return entry
}

const makeClient = (options: { sessionGone?: boolean } = {}): {
  client: OpencodeClient
  prompts: { sessionID: string; text: string }[]
} => {
  const prompts: { sessionID: string; text: string }[] = []
  return {
    client: {
      session: {
        get: (call: { path: { id: string } }) =>
          options.sessionGone === true
            ? Promise.reject(new Error("session deleted"))
            : Promise.resolve({ data: { id: call.path.id, agent: "build" } }),
        promptAsync: (call: { path: { id: string }; body: { parts: { text: string }[] } }) => {
          prompts.push({ sessionID: call.path.id, text: call.body.parts[0]?.text ?? "" })
          return Promise.resolve({ data: undefined })
        },
        abort: () => Promise.resolve({}),
      },
    } as unknown as OpencodeClient,
    prompts,
  }
}

interface ExecuteCall {
  args: WorkflowArgs
  context: WorkflowContext
  /** The manifest as the engine saw it — proving the re-stamp landed BEFORE execution. */
  manifestAtCall: Manifest | undefined
}

/** A fake engine that records its inputs and completes the run. */
const makeExecute = (): { fn: typeof execute; calls: ExecuteCall[] } => {
  const calls: ExecuteCall[] = []
  const fn = async (args: WorkflowArgs, context: WorkflowContext): Promise<WorkflowResult> => {
    const atCall = await readManifest(RUN_ID, env)
    calls.push({ args, context, manifestAtCall: atCall })
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

// Assertion helpers: the lint's nesting and await-member rules want calls kept shallow.
const dirOf = (runId: string): string => artifactPaths(runId, env).dir

const markerOf = (runId: string): string => join(dirOf(runId), "interrupted.txt")

const readMarker = (runId: string): Promise<string> => readFile(markerOf(runId), "utf8")

const statusOf = async (runId: string): Promise<string | undefined> => {
  const current = await readManifest(runId, env)
  return current?.status
}

const deps = (overrides: Partial<Parameters<typeof resumeInterruptedRuns>[0]> = {}): Parameters<typeof resumeInterruptedRuns>[0] => {
  const { fn } = makeExecute()
  return {
    client: makeClient().client,
    bootId: "current-boot",
    candidates: [],
    options: resolveOptions({}),
    env,
    isProcessAlive: () => false,
    executeFn: fn,
    ...overrides,
  }
}

describe("resumeInterruptedRuns", () => {
  test("adopts an interrupted run from its journal and hydrates the original session", async () => {
    const entries = [journalEntry()],
     entry = await seedCandidate({}, entries),
     { client, prompts } = makeClient(),
     { fn, calls } = makeExecute(),
     notes: string[] = []

    const result = await resumeInterruptedRuns({
      ...deps({ client, executeFn: fn }),
      candidates: [entry],
      onNote: (note) => notes.push(note),
    })
    expect(result).toEqual({ resumed: [RUN_ID], skipped: 0, failed: 0 })

    // The detached task runs concurrently; settle before asserting the artifacts.
    await settlePromiseOf(RUN_ID)

    // The engine saw the ORIGINAL run id, the stored args, and the journal as replay candidates.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.context.runId).toBe(RUN_ID)
    expect(calls[0]?.context.sessionID).toBe(SESSION)
    expect(calls[0]?.args.args).toEqual({ a: 1 })
    expect(calls[0]?.args.script).toBe(SCRIPT)
    expect(calls[0]?.context.previousEntries).toEqual(entries)
    expect(calls[0]?.context.resumedFrom).toBe(RUN_ID)

    // The re-stamp landed BEFORE the engine ran: live again under THIS boot's identity.
    expect(calls[0]?.manifestAtCall?.status).toBe("running")
    expect(calls[0]?.manifestAtCall?.bootId).toBe("current-boot")
    expect(calls[0]?.manifestAtCall?.pid).toBe(process.pid)
    expect(calls[0]?.manifestAtCall?.endedAt).toBeUndefined()

    // Settled like any run: manifest closed, session hydrated with the interrupted story.
    expect(await statusOf(RUN_ID)).toBe("completed")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.sessionID).toBe(SESSION)
    expect(prompts[0]?.text).toContain(`<workflow-completed run="${RUN_ID}"`)
    expect(prompts[0]?.text).toContain(`${RUN_ID} was interrupted when opencode exited; it has been resumed — 1 agent(s) replayed from the journal`)

    // Adopted runs lose the hint marker: the run is live again, not interrupted.
    await expect(readMarker(RUN_ID)).rejects.toThrow()
    expect(notes).toEqual([`ultraopen: resuming ${RUN_ID} — interrupted when opencode exited`])

    // The launch-gating registry holds no residue once the run settled.
    expect(liveRunsForSession(SESSION)).toEqual([])
  })

  test("skips a run whose interruption is older than the TTL window", async () => {
    const entry = await seedCandidate({ endedAt: Date.now() - 72 * 60 * 60 * 1000 }),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    // Skipped before the claim, so the hint marker survives untouched.
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("honors the autoResume opt-out", async () => {
    const entry = await seedCandidate(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns({
      ...deps({ executeFn: fn, options: resolveOptions({ autoResume: false }) }),
      candidates: [entry],
    })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
  })

  test("skips a run whose stored args no longer match the manifest hash", async () => {
    // A hand-edited manifest must never replay against guessed inputs: the args on disk are
    // re-hashed against argsHash, and the mismatch skips the whole run.
    const entry = await seedCandidate({ argsHash: argsHash({ a: 999 }) }),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("skips a run whose original session no longer exists", async () => {
    const entry = await seedCandidate(),
     { client, prompts } = makeClient({ sessionGone: true }),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ client, executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    // The hint marker was restored, so the next boot still offers the manual path.
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
    expect(prompts).toEqual([])
  })

  test("skips a run whose children recorded a stop request", async () => {
    // The crash-mid-stop race: the user asked to stop, the process died before the cancelled
    // write landed. The journal's stop marker must keep that run off the resume path forever.
    const stoppedEntry: JournalEntry = { ...journalEntry(), status: "null", reason: "aborted", detail: STOP_ABORT_REASON },
     entry = await seedCandidate({}, [stoppedEntry]),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("never adopts a run whose recorded pid is still alive", async () => {
    // Concurrent opencode processes share the data root; the reaper's veto is re-checked here so
    // a stale candidate list cannot execute a journal another process may be writing.
    const entry = await seedCandidate(),
     { fn } = makeExecute()

    const result = await resumeInterruptedRuns({
      ...deps({ executeFn: fn, isProcessAlive: () => true }),
      candidates: [entry],
    })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("caps adoptions per boot, oldest interruption first", async () => {
    const older = await seedCandidate({ runId: "wf_older001", startedAt: Date.now() - 60_000 }),
     newer = await seedCandidate({ runId: "wf_newer001", startedAt: Date.now() - 10_000 }),
     { client } = makeClient(),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns({
      ...deps({ client, executeFn: fn, options: resolveOptions({ autoResumeMax: 1 }) }),
      candidates: [newer, older],
    })
    expect(result).toEqual({ resumed: ["wf_older001"], skipped: 1, failed: 0 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.context.runId).toBe("wf_older001")
    // The over-cap candidate keeps its hint marker and orphaned record: manually resumable.
    expect(await statusOf("wf_newer001")).toBe("orphaned")
    expect(await readMarker("wf_newer001")).toBe("wf_newer001")
    await settlePromiseOf("wf_older001")
  })

  test("cannot adopt a run whose hint marker is already claimed", async () => {
    // The rename is the cross-process claim: a second boot racing the first finds the marker
    // gone and skips instead of double-executing one journal.
    const entry = await seedCandidate()
    await rm(markerOf(RUN_ID))
    const { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
  })

  test("a failed adoption leaves the hint and the orphaned record intact", async () => {
    // An unwritable manifest cannot be re-stamped; the run keeps its hint so the user — not an
    // invisible boot loop — decides what happens to it.
    const entry = await seedCandidate()
    await chmod(join(dirOf(RUN_ID), "manifest.json"), 0o400)
    const { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 0, failed: 1 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
    expect(await readMarker(RUN_ID)).toBe(RUN_ID)
  })

  test("a corrupt persisted script keeps the run orphaned with its hint", async () => {
    const entry = await seedCandidate()
    await writeScript(RUN_ID, "const const const", env)
    const { fn } = makeExecute()

    const result = await resumeInterruptedRuns({ ...deps({ executeFn: fn }), candidates: [entry] })
    expect(result).toEqual({ resumed: [], skipped: 1, failed: 0 })
    expect(await statusOf(RUN_ID)).toBe("orphaned")
  })

  test("a resumed run that fails still hydrates the interrupted story", async () => {
    const entry = await seedCandidate(),
     { client, prompts } = makeClient(),
     fn = ((): Promise<never> => Promise.reject(new Error("engine exploded"))) as unknown as typeof execute

    await resumeInterruptedRuns({ ...deps({ client, executeFn: fn }), candidates: [entry] })
    await settlePromiseOf(RUN_ID)

    expect(await statusOf(RUN_ID)).toBe("failed")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toContain(`<workflow-failed run="${RUN_ID}"`)
    expect(prompts[0]?.text).toContain(`${RUN_ID} was interrupted when opencode exited; it has been resumed — 0 agent(s) replayed from the journal`)
    expect(await readFile(artifactPaths(RUN_ID, env).failurePath, "utf8")).toContain("engine exploded")
  })

  test("a throwing note sink never breaks the sweep", async () => {
    // onNote is an injectable surface; a hostile sink must cost the run its adoption record, not
    // the boot itself — the outer never-rejects contract counts it and moves on.
    const entry = await seedCandidate(),
     { fn, calls } = makeExecute()

    const result = await resumeInterruptedRuns({
      ...deps({ executeFn: fn }),
      candidates: [entry],
      onNote: () => {
        throw new Error("hostile sink")
      },
    })
    expect(result).toEqual({ resumed: [], skipped: 0, failed: 1 })
    expect(calls).toHaveLength(0)
  })

  test("saved-workflow scan notes ride the sweep's own note sink", async () => {
    // A broken saved workflow is skipped with a note, exactly like a launch's scan — so a
    // resumed script's `workflow("name")` resolution explains itself the same way.
    const brokenDir = join(base, "workflows")
    await mkdir(brokenDir, { recursive: true })
    await writeFile(join(brokenDir, "broken.js"), "const const const", "utf8")
    const entry = await seedCandidate(),
     notes: string[] = [],
     { fn } = makeExecute()

    await resumeInterruptedRuns({
      ...deps({ executeFn: fn, options: resolveOptions({ workflowPaths: [brokenDir] }) }),
      candidates: [entry],
      onNote: (note) => notes.push(note),
    })
    await settlePromiseOf(RUN_ID)
    expect(notes.some((note) => note.includes("broken"))).toBe(true)
  })
})