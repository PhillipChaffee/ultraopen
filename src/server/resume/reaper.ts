import { findOrphans, writeManifest } from "./store.js"
import type { OpencodeClient } from "../types.js"

/**
 * Releases child sessions left behind by a process that died mid-run.
 *
 * opencode never cascades an abort to sessions created with a plain `parentID` — that cascade
 * walks background-job entries, which a plugin cannot register. So a server killed during a
 * workflow leaves every one of its subagents alive and billing, with nothing to stop them.
 *
 * `bootId` is what distinguishes "still running in this process" from "abandoned". A pid alone
 * would be ambiguous after reuse, and a timestamp would either reap live runs or miss dead ones.
 */

/** Identifies this process. Regenerated on every start, which is exactly the point. */
export function newBootId(): string {
  return `${process.pid}-${Math.trunc(performance.timeOrigin)}`
}

export type ReapResult = {
  runs: number
  sessions: number
  failures: number
}

/**
 * Aborts orphaned children and marks their runs orphaned.
 *
 * NEVER REJECTS. A session may already be gone, the server may reject the abort, the data root may
 * be unreadable, or a manifest may be unwritable — every one of those is swallowed and reported in
 * the result instead. Callers can therefore fire-and-forget without a handler. The run is already
 * lost by the time this runs; the point is to stop it costing money, not to report on it.
 */
export async function reapOrphans(
  client: OpencodeClient,
  bootId: string,
  options: { onNote?: ((note: string) => void) | undefined; env?: NodeJS.ProcessEnv | undefined } = {},
): Promise<ReapResult> {
  // findOrphans swallows its own I/O errors and returns [], so no catch is needed here.
  const orphans = await findOrphans(bootId, options.env)
  if (orphans.length === 0) return { runs: 0, sessions: 0, failures: 0 }

  let sessions = 0
  let failures = 0

  for (const manifest of orphans) {
    for (const sessionID of manifest.childSessionIDs) {
      try {
        await client.session.abort({ path: { id: sessionID } })
        sessions++
      } catch {
        failures++
      }
    }

    // Mark it orphaned regardless of whether every abort landed, so the next start does not sweep
    // the same run again and re-report it.
    await writeManifest(
      manifest.runId,
      { ...manifest, status: "orphaned", endedAt: manifest.endedAt ?? 0 },
      options.env,
    ).catch(() => undefined)
  }

  options.onNote?.(
    `ultraopen: released ${sessions} subagent session(s) from ${orphans.length} interrupted run(s)` +
      (failures > 0 ? ` (${failures} could not be aborted)` : ""),
  )

  return { runs: orphans.length, sessions, failures }
}
