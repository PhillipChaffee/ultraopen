import type { HostPort } from "../host/port.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import { deletePendingNotification, listPendingNotifications, readManifest } from "./store.js"
import { pruneRuns, reapOrphans } from "./reaper.js"
import { resumeInterruptedRuns } from "./autoresume.js"
import type { execute } from "../tool/workflow.js"

export interface BootSweepOptions {
  env?: NodeJS.ProcessEnv | undefined
  now?: number | undefined
  onNote?: ((note: string) => void) | undefined
  isProcessAlive?: ((pid: number) => boolean) | undefined
  /** Injectable engine for tests, passed through to the project-scoped resume sweep. */
  executeFn?: typeof execute | undefined
}

/**
 * The boot-time durability sweep, in dependency order.
 *
 * 1. The reaper interrupts the children a dead process left behind and harvests the
 *    freshly-interrupted manifests.
 * 2. The durable outbox is replayed: V2's `session.synthetic` is idempotent on the deterministic
 *    `msg_` id, so a settlement that crashed between manifest commit and admission is delivered
 *    exactly once. A cancelled run's outbox is deleted without ever being sent.
 * 3. Prune deletes run directories past retention.
 *
 * Steps 1–3 are the GLOBAL sweep and run ONCE per OS process (`processBootId`), so a same-PID
 * plugin reload cannot re-reap or re-admit. Its orphan list is cached on the coordinator itself
 * (via `runBootSweepOnce`'s returned value), because EVERY project's activation still needs those
 * candidates: project B booting after project A resumes its own runs from A's harvest.
 *
 * 4. The project-scoped auto-resume sweep re-executes the candidates it can, from their journals.
 *
 * The WHOLE body — including step 4 — is tracked on the coordinator: `bootSweepSettled()` is what a
 * first `listRuns({ includeHints: true })` waits for, and auto-resume must claim `interrupted.txt`
 * before that poll can unlink it as a manual hint.
 *
 * Fire-and-forget like every boot-time persistence: no stage rejects.
 */
export function bootSweep(
  host: HostPort,
  project: ProjectRuntime,
  coordinator: RuntimeCoordinator,
  options: BootSweepOptions = {},
): Promise<void> {
  const sweep = runBootSweep(host, project, coordinator, options)
  // Tracked synchronously, in the same tick the caller invoked the sweep, so no RPC handler can
  // observe a half-registered boot.
  coordinator.trackBootSweep(sweep)
  return sweep
}

async function runBootSweep(
  host: HostPort,
  project: ProjectRuntime,
  coordinator: RuntimeCoordinator,
  options: BootSweepOptions,
): Promise<void> {
  const orphaned = await coordinator.runBootSweepOnce(async () => {
    const reaped = await reapOrphans(host, coordinator.processBootId, {
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
      ...(options.onNote === undefined ? {} : { onNote: options.onNote }),
    })

    await replayOutbox(host, options.env)

    await pruneRuns({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.now === undefined ? {} : { now: options.now }),
      autoResumeTtlHours: project.options.autoResumeTtlHours,
    })
    return reaped.orphaned
  })

  await resumeInterruptedRuns(host, project, coordinator, {
    bootId: coordinator.processBootId,
    candidates: orphaned,
    directory: host.location.directory,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.isProcessAlive === undefined ? {} : { isProcessAlive: options.isProcessAlive }),
    ...(options.onNote === undefined ? {} : { onNote: options.onNote }),
    ...(options.executeFn === undefined ? {} : { executeFn: options.executeFn }),
  })
}

/**
 * Replays every standing outbox record through the idempotent synthetic admission.
 *
 * A cancelled run is never hydrated, and its file is removed (the stop path's own invariant). The
 * file is removed on `admitted` and `session-missing` — the two outcomes where the message can
 * never be owed again — and kept on `error`/`conflict` for the next boot.
 */
async function replayOutbox(host: HostPort, env: NodeJS.ProcessEnv | undefined): Promise<void> {
  for (const record of await listPendingNotifications(env)) {
    const manifest = await readManifest(record.runId, env)
    if (manifest?.status === "cancelled") {
      await deletePendingNotification(record.runId, env)
      continue
    }
    const result = await host.admitSynthetic({
      sessionID: record.sessionID,
      id: record.id,
      text: record.text,
      description: record.description,
      metadata: {
        ultraopen: { kind: "outcome", runId: record.runId, workflow: record.workflow, status: record.status },
      },
      delivery: "steer",
      resume: true,
    }).catch(() => "error" as const)
    if (result === "admitted" || result === "session-missing") {
      await deletePendingNotification(record.runId, env)
    }
  }
}
