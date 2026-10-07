import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beginRun, endRun, loadResume, markCancelled, writeTerminalManifest } from "../src/server/resume/persist.js"
import { artifactPaths, appendJournalEntry, ensureRunDir, readJournal, readManifest, writeManifest } from "../src/server/resume/store.js"
import { CONTROL_STOP_ABORT_REASON, STOP_ABORT_REASON } from "../src/server/resume/journal.js"
import type { JournalEntry, Manifest } from "../src/server/resume/journal.js"

let base: string,
 env: NodeJS.ProcessEnv

const record = {
  runId: "wf_abc123",
  sessionID: "ses_1",
  source: "export const meta = {}",
  args: { a: 1 },
  bootId: "boot-1",
},

 entry: JournalEntry = {
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
  // Restore write permission before cleanup: tests make the run DIRECTORY read-only (atomic
  // writes are blocked by the directory, not the file), and rm needs the write back.
  await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_abc123"), 0o700).catch(
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

  test("records the raw args string alongside the hydrated value when hydration fired (#78)", async () => {
    const manifest = await beginRun({ ...record, args: { a: 1 }, argsRawString: '{"a":1}' }, env)
    expect(manifest?.args).toEqual({ a: 1 })
    expect(manifest?.argsRawString).toBe('{"a":1}')
    // A non-hydrated launch carries no raw-string field, so manifests stay byte-shape stable.
    const plain = await beginRun({ ...record }, env)
    expect(plain?.argsRawString).toBeUndefined()
  })

  test("records the launch's title and description on the manifest (#142)", async () => {
    const manifest = await beginRun({ ...record, title: "Fix the login bug", description: "The auth flow" }, env)
    expect(manifest?.title).toBe("Fix the login bug")
    expect(manifest?.description).toBe("The auth flow")
    // Round-trip: what beginRun wrote is what a later read returns.
    const onDisk = await readManifest("wf_abc123", env)
    expect(onDisk?.title).toBe("Fix the login bug")
    expect(onDisk?.description).toBe("The auth flow")
  })

  test("an untitled launch records neither field — the manifest shape is unchanged", async () => {
    const manifest = await beginRun(record, env)
    expect(manifest?.title).toBeUndefined()
    expect(manifest?.description).toBeUndefined()
    const onDisk = await readManifest("wf_abc123", env)
    expect(onDisk).not.toHaveProperty("title")
    expect(onDisk).not.toHaveProperty("description")
  })

  test("the terminal rewrite preserves the recorded title and description (#142)", async () => {
    // endRun rewrites the manifest whole; the launch metadata is not the settle's to drop.
    const manifest = await beginRun({ ...record, title: "Fix the login bug", description: "The auth flow" }, env)
    await endRun(manifest, { status: "completed", entries: [entry], value: { done: true }, childSessionIDs: ["c1"] }, env)
    const settled = await readManifest("wf_abc123", env)
    expect(settled?.status).toBe("completed")
    expect(settled?.title).toBe("Fix the login bug")
    expect(settled?.description).toBe("The auth flow")
  })
})

describe("the terminal-write race (#164)", () => {
  test("a settle whose rename was clobbered by a landed cancel abandons the journal and result", async () => {
    // Round-5 shape: the settle's rename lands, the stop's cancelled rename lands after it,
    // and endRun must NOT publish journal/result beside a cancelled record it no longer owns.
    await beginRun(record, env)
    let staged = false
    const clobberingWrite = async (runId: string, manifest: Manifest, e?: NodeJS.ProcessEnv): Promise<boolean> => {
      const won = await writeTerminalManifest(runId, manifest, e)
      if (won && !staged) {
        staged = true
        // The stop's cancel rename landing inside the settle's re-check→rename gap.
        await writeManifest(runId, { ...manifest, status: "cancelled", childSessionIDs: [] }, e)
      }
      return won
    }
    const manifest = await readManifest("wf_abc123", env)
    if (!manifest) {throw new Error("the run was not opened")}
    await endRun(manifest, { status: "completed", entries: [entry], value: { done: true }, childSessionIDs: ["c1"] }, env, clobberingWrite)
    const standing = await readManifest("wf_abc123", env)
    expect(standing?.status).toBe("cancelled")
    const resultFile = Bun.file(artifactPaths("wf_abc123", env).resultPath)
    expect(await resultFile.exists()).toBe(false)
    expect(await readJournal("wf_abc123", env)).toEqual([])
  })

  test("the stop's cancelled write re-claims when a racing settle renames over it after verification", async () => {
    // The stop's rename wins and verifies; the settle's rename lands during the persistence
    // window; the poll detects the flip and re-claims — the cancelled record must stand.
    await beginRun(record, env)
    let clobbered = false
    const racingWrite = async (runId: string, manifest: Manifest, e?: NodeJS.ProcessEnv): Promise<boolean> => {
      const won = await writeTerminalManifest(runId, manifest, e)
      if (won && !clobbered) {
        clobbered = true
        // The settle's rename lands just after the stop's verification read.
        setTimeout(() => {
          void writeManifest(runId, { ...manifest, status: "completed", childSessionIDs: ["c1"] }, e)
        }, 10)
      }
      return won
    }
    const manifest = await readManifest("wf_abc123", env)
    if (!manifest) {throw new Error("the run was not opened")}
    const settled = await markCancelled(manifest, [], env, racingWrite)
    expect(settled?.status).toBe("cancelled")
    // The staged racing write is a floating timer; let it land before asserting — on the
    // pre-fix code the clobber stands (the stop returned before noticing), and the fix's
    // persistence poll must have re-claimed instead.
    await new Promise((resolve) => {setTimeout(resolve, 100)})
    const standing = await readManifest("wf_abc123", env)
    expect(standing?.status).toBe("cancelled")
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
    const entries = await readJournal("wf_abc123", env)
    expect(entries.length).toBe(1)
    const result = JSON.parse(await Bun.file(artifactPaths("wf_abc123", env).resultPath).text())
    expect(result).toEqual({ done: true })
  })

  test("records a failed status", async () => {
    const manifest = await beginRun(record, env)
    await endRun(manifest, { status: "failed", entries: [], value: null, childSessionIDs: [] }, env)
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.status).toBe("failed")
  })

  test("a cancelled status is terminal and a later failed-write never overwrites it", async () => {
    // The stop path marks the manifest cancelled while the detached task is still unwinding;
    // that task's failure catch then calls endRun with `failed`. First terminal write wins.
    const opened = await beginRun(record, env)
    if (!opened) {throw new Error("the run did not open")}
    await writeManifest("wf_abc123", { ...opened, status: "cancelled" }, env)
    await endRun(
      opened,
      { status: "failed", entries: [entry], value: null, childSessionIDs: [] },
      env,
    )
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.status).toBe("cancelled")
    // The journal and result are skipped with the status: the cancelled record stands whole.
    expect(await readJournal("wf_abc123", env)).toEqual([])
    expect(await Bun.file(artifactPaths("wf_abc123", env).resultPath).exists()).toBe(false)
  })

  test("the first terminal status wins whatever it is", async () => {
    const manifest = await beginRun(record, env)
    await endRun(manifest, { status: "completed", entries: [], value: 1, childSessionIDs: [] }, env)
    await endRun(manifest, { status: "failed", entries: [], value: null, childSessionIDs: [] }, env)
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.status).toBe("completed")
  })

  test("is a no-op when the run was never opened", async () => {
    await endRun(undefined, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env)
    expect(await readManifest("wf_abc123", env)).toBeUndefined()
  })

  test("a disk-write failure is swallowed, so a completed run is never lost to a persistence error", async () => {
    // Writes are atomic (temp + rename, #136), so blocking them means blocking the DIRECTORY:
    // the temp file cannot be created, every endRun write fails, and the error stays swallowed.
    const manifest = await beginRun(record, env)
    await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_abc123"), 0o500)

    await expect(
      endRun(manifest, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env),
    ).resolves.toBeUndefined()
  })
})

describe("markCancelled — the stop path's terminal write", () => {
  test("marks a running run cancelled, naming the children, without touching journal or result", async () => {
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    // The stop path must not clobber what the run already flushed incrementally.
    await appendJournalEntry("wf_abc123", entry, env)

    const settled = await markCancelled(manifest, ["child-1"], env)

    expect(settled?.status).toBe("cancelled")
    expect(settled?.childSessionIDs).toEqual(["child-1"])
    expect(settled?.endedAt).toBeGreaterThan(0)
    // The journal's incrementally flushed entries survive the cancel write: a stopped run
    // remains resumable for the agents that already completed.
    expect(await readJournal("wf_abc123", env)).toEqual([entry])
    expect(await Bun.file(artifactPaths("wf_abc123", env).resultPath).exists()).toBe(false)
  })

  test("the cancelled record wins over the detached task's later failed-write", async () => {
    // The stop path marks cancelled while the detached task is still unwinding; the task's
    // failure catch then calls endRun with `failed`. First terminal write wins.
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    await appendJournalEntry("wf_abc123", entry, env)
    await markCancelled(manifest, ["child-1"], env)
    await endRun(manifest, { status: "failed", entries: [entry], value: null, childSessionIDs: [] }, env)
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.status).toBe("cancelled")
    expect(await readJournal("wf_abc123", env)).toEqual([entry])
  })

  test("returns the standing terminal manifest untouched when the run already settled", async () => {
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    await endRun(manifest, { status: "completed", entries: [entry], value: 1, childSessionIDs: [] }, env)

    const settled = await markCancelled(manifest, ["child-1"], env)

    expect(settled?.status).toBe("completed")
    expect(settled?.endedAt).toBeGreaterThan(0)
    // The first terminal record stands whole: no cancel rewrite raced over it.
    const result = JSON.parse(await Bun.file(artifactPaths("wf_abc123", env).resultPath).text())
    expect(result).toBe(1)
  })

  test("a disk-write failure reports undefined instead of lying about a cancel that never landed", async () => {
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    await chmod(join(base, "opencode", "tool-output", "ultraopen", "wf_abc123"), 0o500)

    expect(await markCancelled(manifest, [], env)).toBeUndefined()
  })

  test("re-claims a settle that echoed the tool stop's abort, journal-discriminated", async () => {
    // At CI speed the stop's abort can precede its manifest write: the unwind's failed
    // settle lands first, and the journal's stop detail is the discriminator that lets
    // the stop's cancellation re-claim what its own abort authored.
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    const stoppedEntry: JournalEntry = { ...entry, status: "null", reason: "aborted", detail: STOP_ABORT_REASON }
    await appendJournalEntry("wf_abc123", stoppedEntry, env)
    await endRun(manifest, { status: "failed", entries: [stoppedEntry], value: null, childSessionIDs: [] }, env)

    const settled = await markCancelled(manifest, [], env)
    expect(settled?.status).toBe("cancelled")
  })

  test("re-claims the control channel's abort echo — the provenance suffix counts as the stop", async () => {
    // The run-control channel stops with its own reason string (the canonical stop
    // reason plus its provenance). The recognizer must accept it, or a TUI stop that
    // loses the first manifest race would leave the run recorded failed forever.
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    const stoppedEntry: JournalEntry = { ...entry, status: "null", reason: "aborted", detail: CONTROL_STOP_ABORT_REASON }
    await appendJournalEntry("wf_abc123", stoppedEntry, env)
    await endRun(manifest, { status: "failed", entries: [stoppedEntry], value: null, childSessionIDs: [] }, env)

    const settled = await markCancelled(manifest, [], env)
    expect(settled?.status).toBe("cancelled")
  })

  test("a genuine failure stands — a failed settle with no stop detail is never re-claimed", async () => {
    // The discriminator exists to identify the stop's OWN abort echo; without it, a run
    // that failed on its own a moment before the stop arrived keeps its honest record.
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    await appendJournalEntry("wf_abc123", entry, env)
    await endRun(manifest, { status: "failed", entries: [entry], value: null, childSessionIDs: [] }, env)

    const settled = await markCancelled(manifest, [], env)
    expect(settled?.status).toBe("failed")
  })

  test("re-claims the abort's echo when the racing settle clobbers the cancel's own write", async () => {
    // The live shape the technical e2e's stop probe hit: the stop's cancelled rename and
    // the unwind's failed rename both passed their re-checks (each saw `running`), and the
    // settle's rename landed second — clobbering the cancel that was already on disk.
    // The won branch's post-write read then sees `failed`. The journal is the
    // discriminator, as everywhere: the abort's echo re-claims what the stop authored.
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    const stoppedEntry: JournalEntry = { ...entry, status: "null", reason: "aborted", detail: STOP_ABORT_REASON }
    await appendJournalEntry("wf_abc123", stoppedEntry, env)

    // Deterministic clobber: the real terminal write lands cancelled, and the racing
    // settle's rename — which passed its own re-check a beat earlier — lands over it
    // before markCancelled's post-write read.
    const settled = await markCancelled(manifest, ["child-1"], env, async (runId, cancelled, writeEnv) => {
      const won = await writeTerminalManifest(runId, cancelled, writeEnv)
      await writeManifest(runId, { ...cancelled, status: "failed", endedAt: 1 }, writeEnv)
      return won
    })

    expect(settled?.status).toBe("cancelled")
    expect(settled?.childSessionIDs).toEqual(["child-1"])
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.status).toBe("cancelled")
  })

  test("a clobbering settle with no stop detail keeps its genuine record", async () => {
    // Same race shape, but the journal carries no stop detail: the settle was genuine
    // (the run failed on its own while the stop's write was in flight), so the stop's
    // cancellation must NOT re-claim it.
    const manifest = await beginRun(record, env)
    if (!manifest) {throw new Error("the run did not open")}
    await appendJournalEntry("wf_abc123", entry, env)

    const settled = await markCancelled(manifest, [], env, async (runId, cancelled, writeEnv) => {
      const won = await writeTerminalManifest(runId, cancelled, writeEnv)
      await writeManifest(runId, { ...cancelled, status: "failed", endedAt: 1 }, writeEnv)
      return won
    })

    expect(settled?.status).toBe("failed")
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.status).toBe("failed")
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

test("the checked terminal write refuses when the manifest already settled (#136)", async () => {
  // The commit-point refuse branch: a late settle's staged write sees the cancellation and
  // abandons — nothing on disk is overwritten, no temp is left behind.
  const manifest = await beginRun(record, env)
  if (!manifest) {throw new Error("the run did not open")}
  await markCancelled(manifest, [], env)
  expect(await writeTerminalManifest("wf_abc123", { ...manifest, status: "completed", endedAt: Date.now() }, env)).toBe(false)
  const standing = await readManifest("wf_abc123", env)
  expect(standing?.status).toBe("cancelled")
  const entries = await readdir(dirname(artifactPaths("wf_abc123", env).manifestPath))
  expect(entries.filter((e) => e.includes(".tmp"))).toEqual([])
})

test("markCancelled never rejects, even on a caller error (#136)", async () => {
  // The reaper's fire-and-forget contract applies to the stop path too: the TUI stop and the
  // tool stop both call this without a handler, so a caller error (a missing manifest record)
  // must surface as undefined, never a rejection.
  expect(await markCancelled(undefined as unknown as Parameters<typeof markCancelled>[0], [], env)).toBeUndefined()
})

test("beginRun stays honest when the run dir cannot be created (#136)", async () => {
  // The launch's contract: a beginRun failure aborts the launch with a friendly message —
  // which requires beginRun itself to return undefined instead of rejecting when the run dir
  // is unwritable (the checked-write's refusal path starts here, at creation).
  const root = join(base, "opencode", "tool-output", "ultraopen")
  await mkdir(root, { recursive: true })
  await chmod(root, 0o500)
  try {
    expect(await beginRun(record, env)).toBeUndefined()
  } finally {
    await chmod(root, 0o700)
  }
})
