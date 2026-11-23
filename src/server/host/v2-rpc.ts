import { readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { RpcInterruptedHint, RpcRunView } from "../../rpc.js"
import {
  parseListRunsInput,
  parseStopRunInput,
  UltraopenRpc,
} from "../../rpc.js"
import type { HostPort } from "./port.js"
import type { RuntimeCoordinator } from "../runtime/coordinator.js"
import { stopRun } from "../tool/background.js"
import type { Manifest } from "../resume/journal.js"
import { INTERRUPTED_MARKER, artifactPaths, listManifests } from "../resume/store.js"
import { readProgressSnapshot } from "../resume/progress.js"
import { rpcViewFromLive, rpcViewFromManifest } from "../runtime/views.js"

/**
 * The `ultraopen` RPC surface: run listing, confirmed stop, and the `runUpdated` broadcast.
 *
 * `listRuns` deliberately combines TWO sources. Live runs come from the process coordinator, so a
 * caller sees a run that has not yet written a progress snapshot; disk manifests let a remote TUI
 * — or a run launched by another process — see history and synthetic runs. A live run wins a
 * duplicate id, because its state is fresher than the disk it is about to write.
 */

/**
 * How many settled disk runs one poll may read.
 *
 * The run-data root is never pruned by id, so an active project can accumulate thousands of
 * settled runs. Reading every one (each a manifest plus a progress snapshot) would turn a TUI
 * poll into unbounded I/O. Active runs are always read; history is capped to the newest of these,
 * which is exactly the set a sidebar can show.
 */
export const MAX_RPC_SETTLED_RUNS = 20

/** Everything the RPC handlers need. */
export interface RunRpcDeps {
  /** The reloadable host proxy: `stopRun` interrupts the host current at call time. */
  readonly host: HostPort
  readonly coordinator: RuntimeCoordinator
  readonly env?: NodeJS.ProcessEnv | undefined
}

/** Registers the RPC definition and its handlers with the V2 plugin context. */
export async function registerRunRpc(
  ctx: Plugin.Context,
  deps: RunRpcDeps,
): Promise<RpcRegistration<typeof UltraopenRpc>> {
  return await ctx.rpc.register(UltraopenRpc, {
    listRuns: async (input) => {
      const parsed = parseListRunsInput(input)
      // A hint is written by the boot sweep, so a first poll that raced the sweep would silently
      // miss it and never ask again. Waiting here is cheap: the sweep is once per process.
      if (parsed.includeHints === true) {await deps.coordinator.bootSweepSettled()}
      // ONE disk read, shared by the listing and the hints. The sweep is settled by this point, so
      // nothing it wrote can land after this snapshot and be missed.
      const manifests = await listManifests(deps.env),
       runs = await listRunViews(deps, parsed.sessionID, manifests)
      if (parsed.includeHints !== true) {return { runs }}
      const hints = await consumeInterruptedHints(manifests, deps)
      return hints.length === 0 ? { runs } : { runs, hints }
    },

    stopRun: async (input, context) => {
      const { runId } = parseStopRunInput(input)
      const result = await stopRun(
        runId,
        deps.host,
        deps.coordinator,
        deps.env === undefined ? {} : { env: deps.env },
      )
      if (result.outcome === "not_found") {
        return context.error("not_found", result.detail, { runId })
      }
      if (result.outcome === "stop_failed") {
        return context.error("stop_failed", result.detail, { runId, reason: result.detail })
      }
      return { runId: result.runId, outcome: result.outcome }
    },
  })
}

/**
 * Live coordinator runs plus the bounded slice of disk history, deduplicated by run id.
 *
 * The disk filter runs BEFORE the per-run reads: every active run survives, and history is sorted
 * by start time so the cap keeps the newest. Only the survivors pay for a progress read.
 */
async function listRunViews(
  deps: RunRpcDeps,
  sessionID: string | undefined,
  manifests: readonly Manifest[],
): Promise<RpcRunView[]> {
  const byId = new Map<string, RpcRunView>()
  for (const run of deps.coordinator.runs.values()) {
    if (sessionID !== undefined && run.sessionID !== sessionID) {continue}
    byId.set(run.runId, rpcViewFromLive(run))
  }

  const candidates = manifests.filter(
     (manifest) => !byId.has(manifest.runId) && (sessionID === undefined || manifest.sessionID === sessionID),
    ),
   active = candidates.filter((manifest) => manifest.status === "running"),
   settled = candidates
     .filter((manifest) => manifest.status !== "running")
     // Newest first; the run id breaks a same-millisecond tie so the 20-run cap is deterministic.
     .toSorted((left, right) => right.startedAt - left.startedAt || left.runId.localeCompare(right.runId))
     .slice(0, MAX_RPC_SETTLED_RUNS)

  const views = await Promise.all(
    [...active, ...settled].map(async (manifest) =>
      rpcViewFromManifest(manifest, await readProgressSnapshot(manifest.runId, deps.env)),
    ),
  )
  for (const view of views) {byId.set(view.runId, view)}
  return [...byId.values()].toSorted((left, right) => left.startedAt - right.startedAt)
}

/**
 * The interrupted-run hints, consumed after their first successful read.
 *
 * The once-only rule is per RUN: the first `includeHints` caller sees the hint and its marker is
 * removed, so a later caller sees nothing. The manifest stays until resume or retention prunes it.
 * Markers are probed in parallel — the manifests were already read once by the caller.
 *
 * Only THIS project's markers are consumed. The run-data root is shared by every opencode process,
 * so Project A's first poll must not unlink Project B's `interrupted.txt` — B's own auto-resume
 * sweep is the only reader that may claim it. Unscoped (pre-upgrade/synthetic) manifests still
 * hint, because nothing records whose they are.
 */
async function consumeInterruptedHints(
  manifests: readonly Manifest[],
  deps: RunRpcDeps,
): Promise<RpcInterruptedHint[]> {
  const projectID = deps.host.location.projectID
  const found = await Promise.all(
    manifests.map(async (manifest): Promise<RpcInterruptedHint | undefined> => {
      if (manifest.projectID !== undefined && manifest.projectID !== projectID) {return undefined}
      const markerPath = join(artifactPaths(manifest.runId, deps.env).dir, INTERRUPTED_MARKER)
      let marker: string
      try {
        marker = await readFile(markerPath, "utf8")
      } catch {
        return undefined
      }
      if (marker.trim() === "") {return undefined}
      const progress = await readProgressSnapshot(manifest.runId, deps.env)
      await unlink(markerPath).catch(() => undefined)
      return { runId: manifest.runId, workflow: progress?.workflow ?? "workflow" }
    }),
  )
  return found.filter((hint): hint is RpcInterruptedHint => hint !== undefined)
}
