import { argsHash, sourceHash } from "./key.js"
import { parseJournal, type JournalEntry, type Manifest } from "./journal.js"
import {
  appendJournal,
  ensureRunDir,
  readJournal,
  readManifest,
  writeManifest,
  writeResult,
  writeScript,
} from "./store.js"

/**
 * Ties a run's lifecycle to disk.
 *
 * Everything here is best-effort. A workflow that produced good results must not fail because the
 * disk was full or a directory was unwritable — the caller already has the answer in memory, and
 * losing the ability to RESUME is a much smaller harm than losing the run itself.
 */

export type RunRecord = {
  runId: string
  sessionID: string
  source: string
  args: unknown
  bootId: string
}

/** Opens a run: creates its directory, persists the script, and marks it running. */
export async function beginRun(record: RunRecord, env?: NodeJS.ProcessEnv): Promise<Manifest | undefined> {
  try {
    await ensureRunDir(record.runId, env)
    const manifest: Manifest = {
      runId: record.runId,
      bootId: record.bootId,
      pid: process.pid,
      sessionID: record.sessionID,
      sourceHash: sourceHash(record.source),
      argsHash: argsHash(record.args),
      status: "running",
      childSessionIDs: [],
      // Wall-clock, stamped by the host rather than the script — scripts cannot read the clock at
      // all, precisely so their behaviour stays reproducible.
      startedAt: Date.now(),
    }
    await writeManifest(record.runId, manifest, env)
    // Persisted so a later `scriptPath` invocation can re-run or resume exactly this program.
    await writeScript(record.runId, record.source, env)
    return manifest
  } catch {
    return undefined
  }
}

/** Closes a run: writes the journal and result, and records the terminal status. */
export async function endRun(
  manifest: Manifest | undefined,
  outcome: { status: "completed" | "failed"; entries: readonly JournalEntry[]; value: unknown; childSessionIDs: string[] },
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!manifest) return
  try {
    await appendJournal(manifest.runId, outcome.entries.map((entry) => JSON.stringify(entry)).join("\n"), env)
    await writeResult(manifest.runId, outcome.value, env)
    await writeManifest(
      manifest.runId,
      {
        ...manifest,
        status: outcome.status,
        childSessionIDs: outcome.childSessionIDs,
        endedAt: Date.now(),
      },
      env,
    )
  } catch {
    // See the note above: a persistence failure must not lose a completed run.
  }
}

export type ResumeSource = {
  entries: JournalEntry[]
  /** Set when the previous run's args differ, which invalidates every cached result. */
  argsChanged: boolean
}

/**
 * Loads a previous run's journal for replay.
 *
 * A changed `args` invalidates everything, and says so: `args` is invisible to the per-call chain
 * but can change every result, so silently replaying against different inputs would be the worst
 * kind of wrong answer.
 */
export async function loadResume(
  resumeFromRunId: string,
  currentArgs: unknown,
  sessionID: string,
  env?: NodeJS.ProcessEnv,
): Promise<ResumeSource> {
  const manifest = await readManifest(resumeFromRunId, env)
  if (!manifest) return { entries: [], argsChanged: false }

  // Resume is same-session by design: a journal from another conversation would replay results
  // produced for a different context.
  if (manifest.sessionID !== sessionID) return { entries: [], argsChanged: false }

  if (manifest.argsHash !== argsHash(currentArgs)) return { entries: [], argsChanged: true }

  return { entries: await readJournal(resumeFromRunId, env), argsChanged: false }
}

export { parseJournal }
