import { readFile, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { artifactPaths, dataRoot, findOrphans, isSafeRunId, readManifest, readManifestState, runDir, writeManifest } from "./store.js"
import type { Manifest } from "./journal.js"
import type { OpencodeClient } from "../types.js"

/**
 * Harvests resume candidates from runs a dead process left behind.
 *
 * opencode never cascades an abort to sessions created with a plain `parentID` — that cascade
 * walks background-job entries, which a plugin cannot register. So a server killed during a
 * workflow leaves every one of its subagents alive and billing, with nothing to stop them. This
 * sweep aborts those children — which is also what makes the run RESUMABLE: the journal already
 * survives (incremental flush), so the auto-resume sweep in resume/autoresume.ts can replay the
 * completed agents and re-run only the missing tail. Runs beyond the resume window (or opted out
 * of auto-resume) are simply abandoned, exactly as before.
 *
 * `bootId` is what distinguishes "still running in this process" from "abandoned". Because the
 * shared data root is visible to EVERY concurrent opencode process, a fresh boot id alone would
 * condemn other live processes' runs — so a recorded pid that is still alive vetoes the reaping
 * of that run. A pid alone is ambiguous after reuse, which is why it is a veto and not the
 * primary signal: pid reuse keeps a truly dead run unreaped, while no pid check would kill a
 * live run.
 */

/** Identifies this process. Regenerated on every start, which is exactly the point. */
export function newBootId(): string {
  return `${process.pid}-${Math.trunc(performance.timeOrigin)}`
}

export interface ReapResult {
  runs: number
  sessions: number
  failures: number
  /** Runs skipped because their owning process is still alive. */
  live: number
  /**
   * The manifests this sweep orphaned — the freshly interrupted runs of THIS boot, in no
   * particular order. The auto-resume sweep consumes them as its candidates; everything else
   * (TTL expiry, guards) keeps them safely orphaned on disk.
   */
  orphaned: Manifest[]
}

/**
 * Non-throwing probe: true when the process holding `pid` looks alive.
 *
 * EPERM means the process exists but we may not signal it — treated as alive. ESRCH is the
 * definitive dead signal. Injectable via options so tests never depend on the host process table.
 */
export function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
  }
}

/** Swallows a best-effort write failure — persistence must never reject the sweep. */
const ignore = (): undefined => undefined

/**
 * Salvages the owner pid out of torn manifest text (#136).
 *
 * A torn manifest usually tears in the TAIL (the verbatim args field is the big one), so the
 * head — runId, bootId, pid — usually survives intact and is recoverable by pattern. Absent,
 * malformed, or out-of-range pids salvage to undefined: no veto.
 */
export function salvagePid(text: string | undefined): number | undefined {
  if (text === undefined) {return undefined}
  const match = /"pid"\s*:\s*(?<pid>\d+)/u.exec(text)
  if (!match) {return undefined}
  const pid = Number(match.groups?.["pid"])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Salvages child session ids out of torn manifest text (#136).
 *
 * Takes ids ONLY from the childSessionIDs region — the run's own sessionID is the parent
 * conversation and must never be aborted. A manifest torn before that region yields nothing:
 * its children are unknown and stay unabortable (the honest limit).
 */
export function salvageSessionIDs(text: string | undefined): string[] {
  if (text === undefined) {return []}
  const region = /"childSessionIDs"\s*:\s*\[(?<ids>[^\]]*)/u.exec(text)
  if (!region) {return []}
  const ids = region.groups?.["ids"]
  const found = ids === undefined ? null : ids.match(/ses_[A-Za-z0-9]+/gu)
  return found === null ? [] : [...new Set(found)]
}

/**
 * Aborts orphaned children, marks their runs orphaned, and reports the fresh resume candidates.
 *
 * NEVER REJECTS. A session may already be gone, the server may reject the abort, the data root may
 * be unreadable, a manifest may be unwritable or malformed — every one of those is swallowed and
 * reported in the result instead. Callers can therefore fire-and-forget without a handler. The
 * children are already orphans by the time this runs; the point is to stop them costing money
 * before the resume sweep decides what the run itself deserves.
 */
export async function reapOrphans(
  client: OpencodeClient,
  bootId: string,
  options: {
    onNote?: ((note: string) => void) | undefined
    env?: NodeJS.ProcessEnv | undefined
    isProcessAlive?: ((pid: number) => boolean) | undefined
  } = {},
): Promise<ReapResult> {
  try {
    // Quarantine pass FIRST (#136): a run whose manifest is unreadable is invisible to every
    // reader — status answers "no run found", findOrphans skips it, and nothing would ever stop
    // or prune it. Tombstone it orphaned so it surfaces and prunes like any interrupted run.
    const alive = options.isProcessAlive ?? defaultProcessAlive
    const quarantine = await quarantineCorruptRuns(client, { env: options.env, isProcessAlive: alive })
    // findOrphans swallows its own I/O errors and returns [], so no catch is needed here.
    const orphans = await findOrphans(bootId, options.env)
    if (orphans.length === 0) {
      const note = quarantineNote(quarantine)
      if (note !== "") {options.onNote?.(note)}
      return { runs: quarantine.quarantined, sessions: quarantine.sessions, failures: quarantine.failures, live: quarantine.live, orphaned: [] }
    }
    // A live pid means the run may still be executing in another concurrent process. Skip it —
    // the reaper's whole job is to stop billing, never to kill work in progress.
    const reapable = orphans.filter((manifest) => !Number.isInteger(manifest.pid) || !alive(manifest.pid)),
     live = orphans.length - reapable.length

    let sessions = quarantine.sessions,
     failures = quarantine.failures

    for (const manifest of reapable) {
      for (const sessionID of manifest.childSessionIDs ?? []) {
        try {
          await client.session.abort({ path: { id: sessionID } })
          sessions++
        } catch {
          failures++
        }
      }

      // Mark it orphaned regardless of whether every abort landed, so the next start does not sweep
      // the same run again and re-report it. The stamp is the moment the run became a pending
      // decision — the auto-resume TTL and the prune window both measure from here. A manifest
      // that somehow already carried an endedAt keeps it.
      await writeManifest(
        manifest.runId,
        { ...manifest, status: "orphaned", endedAt: manifest.endedAt ?? Date.now() },
        options.env,
      ).catch(ignore)
      // And leave a marker the TUI reads, so the next start shows a resume hint
      // for exactly this run. Only orphaning writes it, which is why completed
      // and failed runs never hint. It is also the auto-resume sweep's claim
      // token: adopting a run renames it, so two boots cannot adopt one run.
      await writeFile(
        join(runDir(manifest.runId, options.env), "interrupted.txt"),
        manifest.runId,
        "utf8",
      ).catch(ignore)
    }

    const liveTotal = live + quarantine.live
    if (reapable.length > 0 || liveTotal > 0 || quarantine.quarantined > 0) {
      const parts: string[] = []
      if (reapable.length > 0 || quarantine.quarantined > 0) {
        parts.push(
          `ultraopen: released ${sessions} subagent session(s) from ${reapable.length + quarantine.quarantined} interrupted run(s)${failures > 0 ? ` (${failures} could not be aborted)` : ""}`,
        )
      }
      if (liveTotal > 0) {
        parts.push(`${liveTotal} run(s) skipped — their process is still alive`)
      }
      options.onNote?.(parts.join("; "))
    }

    return { runs: reapable.length + quarantine.quarantined, sessions, failures, live: liveTotal, orphaned: reapable }
  } catch {
    // Any unexpected failure (e.g. a malformed manifest that findOrphans let through) must not
    // break the contract above — a crashed sweep leaves money burning either way.
    return { runs: 0, sessions: 0, failures: 0, live: 0, orphaned: [] }
  }
}

interface QuarantineOutcome {
  quarantined: number
  /** Vetoed torn runs: their salvaged pid is alive — the owner may be mid-recovery. */
  live: number
  sessions: number
  failures: number
}

/** One line for the quarantine pass's outcome; empty when nothing happened. */
function quarantineNote(q: QuarantineOutcome): string {
  const parts: string[] = []
  if (q.quarantined > 0) {
    parts.push(`ultraopen: quarantined ${q.quarantined} corrupt-manifest run(s)${q.failures > 0 ? ` (${q.failures} child abort(s) failed)` : ""}`)
  }
  if (q.live > 0) {
    parts.push(`${q.live} run(s) skipped — their process is still alive`)
  }
  return parts.join("; ")
}

/**
 * Tombstones every run whose manifest is unreadable (#136), with the orphan pass's protections.
 *
 * Per torn run, in order:
 * 1. LIVE-PID VETO — the pid is salvaged from the torn bytes; a live owner means the process may
 *    be mid-write-recovery, and tombstoning it would permanently block its settlement (every
 *    terminal write refuses a non-running manifest) and hang an interrupted marker on working
 *    work. Vetoed runs count in `live`, exactly like the readable orphan pass's live skips.
 * 2. PRESERVE the torn bytes as `manifest.corrupt.bak` — the tombstone must not destroy the only
 *    record of what the run was.
 * 3. SALVAGE the child session ids from the torn text's childSessionIDs region and abort them
 *    best-effort — the children of a corrupt-manifest run keep billing otherwise; ids torn away
 *    mean children unknown (never the parent session).
 * 4. TOMBSTONE orphaned (+ the interrupted.txt marker) so the run surfaces and prunes like any
 *    interrupted run. The lost hashes make it NOT a resume candidate; the auto-resume sweep
 *    skips unhashable manifests by construction.
 */
async function quarantineCorruptRuns(
  client: OpencodeClient,
  options: { env?: NodeJS.ProcessEnv | undefined; isProcessAlive: (pid: number) => boolean },
): Promise<QuarantineOutcome> {
  const outcome: QuarantineOutcome = { quarantined: 0, live: 0, sessions: 0, failures: 0 }
  const root = dataRoot(options.env)
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return outcome
  }
  for (const name of names) {
    if (!isSafeRunId(name)) {continue}
    const read = await readManifestState(name, options.env)
    if (read.state !== "corrupt") {continue}
    const paths = artifactPaths(name, options.env)
    let torn: string | undefined
    try {
      torn = await readFile(paths.manifestPath, "utf8")
    } catch {
      torn = undefined
    }
    const pid = salvagePid(torn)
    if (pid !== undefined && options.isProcessAlive(pid)) {
      outcome.live++
      continue
    }
    if (torn !== undefined) {
      await writeFile(join(paths.dir, "manifest.corrupt.bak"), torn, "utf8").catch(ignore)
    }
    for (const sessionID of salvageSessionIDs(torn)) {
      try {
        await client.session.abort({ path: { id: sessionID } })
        outcome.sessions++
      } catch {
        outcome.failures++
      }
    }
    const now = Date.now()
    await writeManifest(name, {
      runId: name,
      bootId: "corrupt",
      pid: Number.NaN,
      sessionID: "",
      sourceHash: "",
      argsHash: "",
      status: "orphaned",
      childSessionIDs: [],
      startedAt: now,
      endedAt: now,
    }, options.env).catch(ignore)
    await writeFile(join(runDir(name, options.env), "interrupted.txt"), name, "utf8").catch(ignore)
    outcome.quarantined++
  }
  return outcome
}

/**
 * Terminal-status runs older than this are deleted, journal included — keeping every run forever
 * is unbounded disk growth, and resuming a run this old is not worth it.
 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

const HOUR_MS = 60 * 60 * 1000

/**
 * Deletes finished run directories past the retention window. Returns how many were removed.
 *
 * NEVER REJECTS, like reapOrphans — it runs fire-and-forget at plugin init. Every fallible call
 * inside the loop swallows its own failure (readdir via the try below, readManifest via its
 * undefined contract, rm via .catch), so a broken data root simply prunes nothing.
 *
 * Prunable = terminal status AND outside every pending-decision window. Runs still marked
 * `running` are never pruned here: a live long-running workflow must not lose its journal. An
 * `orphaned` run is NOT terminal — it is an unanswered resume decision — so it survives while its
 * interruption is younger than the auto-resume TTL and prunes once the window closes (or when
 * retention passes for a run nobody ever decided about).
 */
export async function pruneRuns(
  options: {
    env?: NodeJS.ProcessEnv | undefined
    now?: number | undefined
    /** The auto-resume window in hours; orphaned runs inside it are pending decisions, not waste. */
    autoResumeTtlHours?: number | undefined
  } = {},
): Promise<number> {
  let names: string[]
  try {
    names = await readdir(dataRoot(options.env))
  } catch {
    return 0
  }

  const now = options.now ?? Date.now(),
   cutoff = now - RETENTION_MS,
   resumeCutoff = now - (options.autoResumeTtlHours ?? 0) * HOUR_MS
  let pruned = 0
  for (const name of names) {
    const manifest = await readManifest(name, options.env)
    if (!manifest || manifest.status === "running") {continue}
    if (manifest.status === "orphaned") {
      // An orphaned run is an unanswered resume decision, not waste: while its interruption is
      // younger than the auto-resume TTL it must survive pruning, or the sweep could adopt a run
      // whose journal was deleted underneath it. Runs whose stamp predates the window prune.
      const interruptedAt = manifest.endedAt ?? manifest.startedAt
      if (typeof interruptedAt === "number" && interruptedAt > resumeCutoff) {continue}
    }
    const ended = manifest.endedAt ?? manifest.startedAt
    if (typeof ended !== "number" || ended > cutoff) {continue}
    await rm(runDir(name, options.env), { recursive: true, force: true }).catch(ignore)
    pruned++
  }
  return pruned
}