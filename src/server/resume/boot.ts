import type { UltraopenOptions } from "../options.js"
import type { OpencodeClient } from "../types.js"
import { pruneRuns, reapOrphans } from "./reaper.js"
import { resumeInterruptedRuns } from "./autoresume.js"

// Re-exported beside the sweep it feeds: the boot id is boot-sweeper-adjacent state, and
// importing one module instead of two keeps the plugin factory inside its dependency budget.
export { newBootId } from "./reaper.js"

/**
 * The boot-time durability sweep, in dependency order.
 *
 * 1. The reaper aborts the children a dead process left behind and harvests the
 *    freshly-interrupted manifests — that abort is also what makes a run resumable, since it
 *    stops the billing while the journal keeps the completed agents.
 * 2. Prune deletes run directories past retention, but never a just-orphaned one: the resume
 *    window guard keeps runs inside the pending-decision TTL, whatever `autoResume` says.
 * 3. The auto-resume sweep re-executes the candidates it can, from their own journals, and
 *    hydrates their original sessions with the outcome.
 *
 * Fire-and-forget like every boot-time persistence: no stage rejects, so plugin init never
 * waits on a slow or unreachable server and no caller needs a catch. Extracted from the plugin
 * factory (src/server/index.ts) to keep the factory inside its line and dependency budgets —
 * the sweep's own comment and ordering live here, where the code is, not at the call site.
 */
export async function bootSweep(
  client: OpencodeClient,
  bootId: string,
  options: UltraopenOptions,
  directory: string | undefined,
): Promise<void> {
  const reaped = await reapOrphans(client, bootId, {})
  void pruneRuns({ autoResumeTtlHours: options.autoResumeTtlHours })
  await resumeInterruptedRuns({
    client,
    bootId,
    candidates: reaped.orphaned,
    options,
    directory,
  })
}
