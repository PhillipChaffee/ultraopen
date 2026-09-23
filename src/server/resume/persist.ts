import { argsHash, sourceHash } from "./key.js"
import type { JournalEntry, Manifest } from "./journal.js"
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

export interface RunRecord {
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

/**
 * Closes a run: writes the journal and result, and records the terminal status.
 *
 * The status is TERMINAL and first-terminal-write-wins: whatever terminal status reached
 * disk first stands. The stop path marks a run `cancelled` while its detached task is
 * still unwinding, and that task's own failure path calls this with `failed` — a later
 * failed-write must never overwrite `cancelled`. The journal and result are skipped with
 * the status: the first terminal record settles the run's whole settlement.
 */
export async function endRun(
  manifest: Manifest | undefined,
  outcome: {
    status: "completed" | "failed" | "cancelled"
    entries: readonly JournalEntry[]
    value: unknown
    childSessionIDs: string[]
  },
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!manifest) {return}
  try {
    // A manifest on disk always starts `running` (beginRun writes it); any other status
    // is a terminal record that already won.
    const current = await readManifest(manifest.runId, env)
    if (current !== undefined && current.status !== "running") {return}
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

/**
 * Marks a run `cancelled` — the stop path's terminal write.
 *
 * Deliberately NOT `endRun({ status: "cancelled" })`: `endRun` rewrites the
 * journal and result from the outcome it is handed, and the stop path has no
 * settlement of its own — its callers would pass empty entries, clobbering the
 * journal entries the run already flushed incrementally. The cancel write is
 * manifest-only, and it obeys the same first-terminal-write-wins rule: it
 * lands only over a still-`running` manifest, so a run that settled a moment
 * earlier keeps its own status and the stop reports the loss honestly.
 *
 * Returns whatever stands on disk after the attempt — `cancelled` when the
 * stop won, the earlier terminal status when it lost the race, `undefined`
 * when the disk could not be read at all.
 */
/**
 * Marks a run `cancelled` — the stop path's terminal write.
 *
 * Deliberately NOT `endRun({ status: "cancelled" })`: `endRun` rewrites the
 * journal and result from the outcome it is handed, and the stop path has no
 * settlement of its own — its callers would pass empty entries, clobbering the
 * journal entries the run already flushed incrementally. The cancel write is
 * manifest-only, and it obeys the same first-terminal-write-wins rule: it
 * lands only over a still-`running` manifest, so a run that settled a moment
 * earlier keeps its own status and the stop reports the loss honestly.
 *
 * The write retries a bounded number of times: a live run's own progress
 * checkpoint can rewrite `running` in the instant between this read and this
 * write (both are plain file writes), and a single clobber must not flip the
 * run's settled status — the retry re-reads and re-claims until the cancelled
 * record stands or another terminal status has already won.
 *
 * Returns whatever stands on disk after the attempt — `cancelled` when the
 * stop won, the earlier terminal status when it lost the race, `undefined`
 * when the disk could not be read at all.
 */
export async function markCancelled(
  manifest: Manifest,
  childSessionIDs: string[],
  env?: NodeJS.ProcessEnv,
): Promise<Manifest | undefined> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readManifest(manifest.runId, env)
      if (current === undefined || current.status !== "running") {return current}
      await writeManifest(
        manifest.runId,
        { ...manifest, status: "cancelled", childSessionIDs, endedAt: Date.now() },
        env,
      )
      const after = await readManifest(manifest.runId, env)
      if (after === undefined || after.status !== "running") {return after}
    }
    return undefined
  } catch {
    return undefined
  }
}

export interface ResumeSource {
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
  if (!manifest) {return { entries: [], argsChanged: false }}

  // Resume is same-session by design: a journal from another conversation would replay results
  // produced for a different context.
  if (manifest.sessionID !== sessionID) {return { entries: [], argsChanged: false }}

  if (manifest.argsHash !== argsHash(currentArgs)) {return { entries: [], argsChanged: true }}

  return { entries: await readJournal(resumeFromRunId, env), argsChanged: false }
}

export { parseJournal } from "./journal.js"
