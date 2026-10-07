import { randomUUID } from "node:crypto"
import { rename, unlink, writeFile } from "node:fs/promises"
import { argsHash, sourceHash } from "./key.js"
import { isStopAbortDetail } from "./journal.js"
import type { JournalEntry, Manifest } from "./journal.js"
import {
  appendJournal,
  artifactPaths,
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
  /**
   * The raw args string the tool boundary received, set ONLY when it hydrated a stringified
   * JSON payload (#78) — the manifest then records both what arrived and what the script sees.
   */
  argsRawString?: string | undefined
  /** The launch's `title` argument (#142), absent when the launch passed none. */
  title?: string | undefined
  /** The launch's `description` argument (#142), absent when the launch passed none. */
  description?: string | undefined
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
      // Persisted verbatim so an auto-resume can re-execute this run without
      // anyone re-supplying the inputs. JSON.stringify drops an undefined value,
      // which keeps "no args" manifests byte-identical to the pre-args format —
      // and `argsHash(undefined)` matches them at read time, so the sweep's
      // hash re-check distinguishes old manifests from tampered ones for free.
      args: record.args,
      // When the boundary hydrated a stringified args (#78), the manifest records BOTH what
      // arrived and what the script will see — the transport repair stays diagnosable on disk.
      ...(record.argsRawString === undefined ? {} : { argsRawString: record.argsRawString }),
      // The launch's title/description metadata (#142), recorded verbatim when present; an
      // absent field is omitted so untitled manifests stay byte-identical to the pre-#142 shape.
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.description === undefined ? {} : { description: record.description }),
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
/**
 * The terminal write WITH a last-instant re-check (#136).
 *
 * The atomic write widened the check-to-rename window (the temp write sits between the status
 * read and the rename), so a concurrent terminal write — a stop's `cancelled` landing while a
 * settle's `failed` was in flight — could land inside the gap and be clobbered by this rename,
 * breaking first-terminal-write-wins. The re-read immediately before the rename collapses the
 * window to two consecutive syscalls: if another terminal record landed since the caller's
 * check, this write abandons instead of overwriting it.
 */
export async function writeTerminalManifest(
  runId: string,
  manifest: Manifest,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> {
  // (#136) STAGE the content first, THEN re-check, THEN rename: the gap between the status
  // read and the rename collapses to two consecutive syscalls, so a concurrent terminal write
  // (a stop landing while a settle is in flight) can no longer hide inside the window and be
  // clobbered — first-terminal-write-wins holds on disk.
  const paths = artifactPaths(runId, env)
  const tmp = `${paths.manifestPath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8")
  } catch {
    // A stage failure (unwritable dir, ENOSPC) is "not won", not a throw: the caller's retry
    // accounting sees the honest refusal and the exhausted-retry fallthrough reports it.
    await unlink(tmp).catch(() => undefined)
    return false
  }
  const current = await readManifest(runId, env)
  if (current !== undefined && current.status !== "running") {
    // No .catch here: the stage just succeeded, so an unlink failure is a real error worth
    // rejecting into the callers' honest-failure paths — not a best-effort cleanup.
    await unlink(tmp)
    return false
  }
  await rename(tmp, paths.manifestPath)
  return true
}

export async function endRun(
  manifest: Manifest | undefined,
  outcome: {
    status: "completed" | "failed" | "cancelled"
    entries: readonly JournalEntry[]
    value: unknown
    childSessionIDs: string[]
  },
  env?: NodeJS.ProcessEnv,
  /** Test-only seam (#164): swap the terminal write to stage a concurrent writer. */
  writeTerminalManifestFn: typeof writeTerminalManifest = writeTerminalManifest,
): Promise<void> {
  if (!manifest) {return}
  try {
    // A manifest on disk always starts `running` (beginRun writes it); any other status
    // is a terminal record that already won.
    const current = await readManifest(manifest.runId, env)
    if (current !== undefined && current.status !== "running") {return}
    // The terminal manifest is the COMMIT POINT and comes FIRST (#136): a settle that loses the
    // race against a stop's cancellation must write NOTHING — the previous order published this
    // settle's journal rewrite and result.json beside a manifest it never won, and a cancelled
    // run then "invented" a result.json (caught live by the e2e stop-path assertion).
    const won = await writeTerminalManifestFn(
      manifest.runId,
      {
        ...manifest,
        status: outcome.status,
        childSessionIDs: outcome.childSessionIDs,
        endedAt: Date.now(),
      },
      env,
    )
    if (!won) {return}
    // The rename landing is not ownership: a racing stop's cancelled rename can land inside
    // the re-check→rename gap (#164) and stand over this record. The journal and result are
    // the SETTLE's artifacts — a cancelled record never settles a result — so whatever stands
    // is re-read before they are published, and a record that is not ours abandons them.
    const standing = await readManifest(manifest.runId, env)
    if (standing === undefined || standing.status !== outcome.status) {return}
    await appendJournal(manifest.runId, outcome.entries.map((entry) => JSON.stringify(entry)).join("\n"), env)
    await writeResult(manifest.runId, outcome.value, env)
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
  * A cancelled write that WON can still be clobbered: the racing settle's
  * rename passes its own still-`running` re-check before the cancel's rename
  * and lands after it (check-then-rename is two syscalls, not one). The
  * post-write read catches this, and the journal is the discriminator as
  * everywhere: an abort's echo re-claims what the stop authored; a genuine
  * settle keeps its status.
  *
  * Returns whatever stands on disk after the attempt — `cancelled` when the
  * stop won, the earlier terminal status when it lost the race, `undefined`
  * when the disk could not be read at all.
 */
/**
 * Whether a landed cancelled record still stands, polled over a bounded window (#164).
 *
 * A verified-then-returned cancelled write can still be renamed away by a racing settle
 * whose rename lands after the stop's verification read — the probe then reads a run the
 * user stopped as completed/failed. The poll re-reads for a short bounded window; a flip
 * sends the caller back into its claim loop, and the settle-side verification (endRun's
 * post-rename re-read) keeps the settle from publishing beside a record it lost to.
 */
const PERSISTENCE_POLLS = 8
const PERSISTENCE_POLL_MS = 30
async function cancelledPersists(runId: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  for (let poll = 0; poll < PERSISTENCE_POLLS; poll++) {
    const current = await readManifest(runId, env)
    if (current === undefined || current.status !== "cancelled") {return false}
    await new Promise((resolve) => {setTimeout(resolve, PERSISTENCE_POLL_MS)})
  }
  return true
}

export async function markCancelled(
  manifest: Manifest,
  childSessionIDs: string[],
  env?: NodeJS.ProcessEnv,
  /** Test-only seam (#161's race): swap the terminal write to stage a concurrent writer. */
  writeTerminalManifestFn: typeof writeTerminalManifest = writeTerminalManifest,
): Promise<Manifest | undefined> {
  try {
    const first = await readManifest(manifest.runId, env)
    if (first === undefined) {return first}
    if (first.status === "cancelled") {return first}
    // A terminal that already stands is the honest loss — UNLESS the run's journal records the
    // stop's own abort reason: then the terminal is the abort's echo (the settle racing the
    // stop that authored it, at CI speed the stop's abort precedes its manifest write), and
    // the stop's cancellation re-claims. The journal is the discriminator: it survives the
    // torn-write and clobber scenarios the manifest does not.
    if (first.status !== "running") {
      const journal = await readJournal(manifest.runId, env)
      if (!journal.some((entry) => isStopAbortDetail(entry.detail))) {return first}
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readManifest(manifest.runId, env)
      if (current === undefined) {return current}
      if (current.status === "cancelled") {return current}
      if (current.status === "running") {
        const won = await writeTerminalManifestFn(
          manifest.runId,
          { ...manifest, status: "cancelled", childSessionIDs, endedAt: Date.now() },
          env,
        )
        if (won) {
          const after = await readManifest(manifest.runId, env)
          if (after === undefined) {return after}
          if (after.status === "cancelled") {
            // Verified is not persisted (#164): a racing rename inside the gap can still
            // land over this record. The poll holds the record's persistence; a flip
            // re-enters the claim.
            if (await cancelledPersists(manifest.runId, env)) {return after}
            continue
          }
          if (after.status === "running") {continue}
          // A different terminal landed over the stop's own cancelled write: the racing
          // settle's rename passed its re-check before the cancel's rename and landed
          // after it — both re-checks saw `running`, because check-then-rename is two
          // syscalls, not one. The journal is the discriminator, as everywhere: the
          // abort's echo re-claims what the stop authored; a genuine settle keeps its
          // status.
          const journal = await readJournal(manifest.runId, env)
          if (!journal.some((entry) => isStopAbortDetail(entry.detail))) {return after}
          continue
        }
      }
      // The disk moved under the stop (a checkpoint's running rewrite, or the abort's echoed
      // settle): the stop authored this cancellation, so it re-claims directly over whatever
      // stands. The manifest-only write keeps the journal/result the run already flushed.
      // A SETTLE terminal without the echo is the honest loss, not a re-claim (#164): the
      // poll-flip route can deliver a genuine settled record here, and clobbering it would
      // stand a cancelled record beside a published result.json. The re-read is live — the
      // stale `current` above can predate the settle's rename.
      const standing = await readManifest(manifest.runId, env)
      if (standing !== undefined && standing.status !== "running" && standing.status !== "cancelled") {
        const journal = await readJournal(manifest.runId, env)
        if (!journal.some((entry) => isStopAbortDetail(entry.detail))) {return standing}
      }
      await writeManifest(
        manifest.runId,
        { ...manifest, status: "cancelled", childSessionIDs, endedAt: Date.now() },
        env,
      )
      const after = await readManifest(manifest.runId, env)
      if (after !== undefined && after.status === "cancelled" && (await cancelledPersists(manifest.runId, env))) {
        // Same persistence discipline as the rename path above (#164).
        return after
      }
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
