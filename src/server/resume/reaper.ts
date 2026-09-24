import { readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { dataRoot, findOrphans, readManifest, runDir, writeManifest } from "./store.js"
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
    // findOrphans swallows its own I/O errors and returns [], so no catch is needed here.
    const orphans = await findOrphans(bootId, options.env)
    if (orphans.length === 0) {return { runs: 0, sessions: 0, failures: 0, live: 0, orphaned: [] }}

    const alive = options.isProcessAlive ?? defaultProcessAlive,
    // A live pid means the run may still be executing in another concurrent process. Skip it —
    // the reaper's whole job is to stop billing, never to kill work in progress.
     reapable = orphans.filter((manifest) => !Number.isInteger(manifest.pid) || !alive(manifest.pid)),
     live = orphans.length - reapable.length

    let sessions = 0,
     failures = 0

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

    if (reapable.length > 0 || live > 0) {
      options.onNote?.(
        `ultraopen: released ${sessions} subagent session(s) from ${reapable.length} interrupted run(s)${ 
          failures > 0 ? ` (${failures} could not be aborted)` : "" 
          }${live > 0 ? ` (${live} run(s) skipped — their process is still alive)` : ""}`,
      )
    }

    return { runs: reapable.length, sessions, failures, live, orphaned: reapable }
  } catch {
    // Any unexpected failure (e.g. a malformed manifest that findOrphans let through) must not
    // break the contract above — a crashed sweep leaves money burning either way.
    return { runs: 0, sessions: 0, failures: 0, live: 0, orphaned: [] }
  }
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