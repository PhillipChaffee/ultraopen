import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beginRun, endRun, loadResume } from "../src/server/resume/persist.js"
import { artifactPaths, readJournal, readManifest, writeManifest, ensureRunDir } from "../src/server/resume/store.js"
import type { JournalEntry } from "../src/server/resume/journal.js"

let base: string
let env: NodeJS.ProcessEnv

const record = {
  runId: "wf_abc123",
  sessionID: "ses_1",
  source: "export const meta = {}",
  args: { a: 1 },
  bootId: "boot-1",
}

const entry: JournalEntry = {
  type: "result",
  key: "k1",
  scopePath: "root",
  ordinal: 0,
  label: "worker",
  status: "ok",
  value: "v",
  outputTokens: 3,
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-persist-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
})

afterEach(async () => {
  // Restore write permission before cleanup: one test makes a manifest read-only.
  await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_abc123", "manifest.json"), 0o600).catch(
    () => undefined,
  )
  await chmod(base, 0o755).catch(() => undefined)
  await rm(base, { recursive: true, force: true })
})

describe("beginRun", () => {
  test("creates the run, marks it running, and persists the script", async () => {
    const manifest = await beginRun(record, env)
    expect(manifest?.status).toBe("running")
    expect(manifest?.bootId).toBe("boot-1")
    expect(manifest?.startedAt).toBeGreaterThan(0)
    expect(await Bun.file(artifactPaths("wf_abc123", env).scriptPath).text()).toBe(record.source)
  })

  test("returns undefined rather than throwing when the run cannot be created", async () => {
    // A workflow that produces good results must not fail because a directory was unwritable —
    // losing the ability to resume is a far smaller harm than losing the run.
    const manifest = await beginRun({ ...record, runId: "wf_../escape" }, env)
    expect(manifest).toBeUndefined()
  })
})

describe("endRun", () => {
  test("writes the journal, the result, and a terminal status", async () => {
    const manifest = await beginRun(record, env)
    await endRun(
      manifest,
      { status: "completed", entries: [entry], value: { done: true }, childSessionIDs: ["c1"] },
      env,
    )

    const updated = await readManifest("wf_abc123", env)
    expect(updated?.status).toBe("completed")
    expect(updated?.childSessionIDs).toEqual(["c1"])
    expect(updated?.endedAt).toBeGreaterThan(0)
    expect((await readJournal("wf_abc123", env)).length).toBe(1)
    expect(JSON.parse(await Bun.file(artifactPaths("wf_abc123", env).resultPath).text())).toEqual({ done: true })
  })

  test("records a failed status", async () => {
    const manifest = await beginRun(record, env)
    await endRun(manifest, { status: "failed", entries: [], value: null, childSessionIDs: [] }, env)
    expect((await readManifest("wf_abc123", env))?.status).toBe("failed")
  })

  test("is a no-op when the run was never opened", async () => {
    await endRun(undefined, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env)
    expect(await readManifest("wf_abc123", env)).toBeUndefined()
  })

  test("a disk-write failure is swallowed, so a completed run is never lost to a persistence error", async () => {
    // The manifest FILE is made read-only: overwriting an existing file needs write permission on
    // the file itself, which makes every endRun write fail while the directory stays usable.
    const manifest = await beginRun(record, env)
    await chmod(artifactPaths("wf_abc123", env).manifestPath, 0o400)

    await expect(
      endRun(manifest, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env),
    ).resolves.toBeUndefined()
  })
})

describe("loadResume", () => {
  const seedPrevious = async (overrides: Partial<Parameters<typeof writeManifest>[1]> = {}): Promise<void> => {
    await ensureRunDir("wf_prev001", env)
    await writeManifest(
      "wf_prev001",
      {
        runId: "wf_prev001",
        bootId: "b",
        pid: 1,
        sessionID: "ses_1",
        sourceHash: "s",
        // Must match argsHash({a:1}) for the happy path; overridden per-test where it should not.
        argsHash: "5cbcd6c4f0d8b3e2c1c1a1e4e1b4d5a0",
        status: "completed",
        childSessionIDs: [],
        startedAt: 0,
        ...overrides,
      },
      env,
    )
  }

  test("loads entries when the session and args both match", async () => {
    // Round-trip through a real run so the recorded argsHash is genuinely correct.
    const manifest = await beginRun({ ...record, runId: "wf_prev001" }, env)
    await endRun(manifest, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env)

    const resume = await loadResume("wf_prev001", { a: 1 }, "ses_1", env)
    expect(resume.entries.length).toBe(1)
    expect(resume.argsChanged).toBe(false)
  })

  test("reports argsChanged and replays NOTHING when args differ", async () => {
    // `args` is invisible to the per-call chain but can change every result, so replaying against
    // different inputs would be the worst kind of wrong answer.
    const manifest = await beginRun({ ...record, runId: "wf_prev001" }, env)
    await endRun(manifest, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env)

    const resume = await loadResume("wf_prev001", { a: 999 }, "ses_1", env)
    expect(resume.entries).toEqual([])
    expect(resume.argsChanged).toBe(true)
  })

  test("refuses a journal from a DIFFERENT session", async () => {
    // Those results were produced for another conversation's context.
    const manifest = await beginRun({ ...record, runId: "wf_prev001" }, env)
    await endRun(manifest, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env)

    const resume = await loadResume("wf_prev001", { a: 1 }, "ses_OTHER", env)
    expect(resume.entries).toEqual([])
    expect(resume.argsChanged).toBe(false)
  })

  test("an unknown run resumes nothing without erroring", async () => {
    expect(await loadResume("wf_missing1", {}, "ses_1", env)).toEqual({ entries: [], argsChanged: false })
  })

  test("a run with a manifest but no journal yields no entries", async () => {
    await seedPrevious({ argsHash: "mismatch" })
    const resume = await loadResume("wf_prev001", { a: 1 }, "ses_1", env)
    expect(resume.entries).toEqual([])
  })
})
