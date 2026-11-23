import { Plugin } from "@opencode/plugin"
import { resolveOptions } from "./options.js"
import { createV2HostPort } from "./host/v2-adapter.js"
import { getCoordinator } from "./runtime/coordinator.js"
import { isLongLivedHost, stopRun } from "./tool/background.js"
import { bootSweep } from "./resume/boot.js"
import { loadBundledSkill, registerTransforms } from "./host/v2-transforms.js"
import { registerHooks, startEventStream } from "./host/v2-hooks.js"
import { registerRunRpc } from "./host/v2-rpc.js"
import { parseSavedWorkflows, scanNamedWorkflows } from "./tool/named.js"
import type { LaunchPermissionInput, WorkflowCommandState } from "./tool/launch.js"

/**
 * The ultraopen server plugin: the V2 composition root.
 *
 * The TUI half is a SEPARATE entry (`./tui`) with its own default export. Every decision lives in
 * the modules this file wires: `host/v2-adapter` owns the wire types, `host/v2-transforms` builds
 * the model-facing surfaces, `host/v2-hooks` owns the per-turn containment and the event loop,
 * `host/v2-rpc` owns the TUI-facing RPC, and `tool/launch` owns the workflow tool's contract.
 *
 * The coordinator is anchored on `globalThis`, so a same-PID plugin reload ADOPTS live runs instead
 * of orphaning them (#180). `deactivateLocation` arms a 2000 ms `.unref()` handoff: a replacement
 * `setup()` inside that window keeps the runs, while an explicit disable lets the timer fire and
 * stop only this scope's runs.
 */

/** The cleanup handoff window; the coordinator's own default, stated here for the contract. */
const HANDOFF_GRACE_MS = 2000

/**
 * Builds the plugin definition.
 *
 * `setup` registers the RPC-independent surfaces first (transforms, hooks), then RPC, and only
 * after that activates the location, starts the event stream and starts the boot sweep — all three
 * synchronously. RPC must be the LAST async registration: a `listRuns({ includeHints: true })`
 * issued the instant the RPC surface exists would otherwise reach `bootSweepSettled()` before the
 * sweep was tracked and silently retire its one-shot hint ask. A failure before `registerRunRpc`
 * leaves nothing to roll back; a synchronous failure after it disposes the registration.
 */
export function createUltraopenServer(): Plugin.Plugin {
  return Plugin.define({
    id: "ultraopen",

    async setup(ctx) {
      const options = resolveOptions(ctx.options),
       coordinator = getCoordinator(),
       location = {
         directory: ctx.location.directory,
         project: { id: ctx.location.project.id, canonical: ctx.location.project.canonical },
       },
       project = coordinator.projectOf(location, options),
       // The raw host is what this activation registers; the proxy is what every consumer holds,
       // so a reload handoff reaches in-flight runs without touching them.
       rawHost = createV2HostPort(ctx),
       host = coordinator.hostFor(project.projectKey, location.directory, rawHost)

      // Transforms and hooks register no RPC and need no activation. Doing them BEFORE RPC keeps
      // `registerRunRpc` as the last await in setup, so the synchronous activation/sweep tail below
      // cannot be split by an inbound RPC handler.
      // Read saved workflows asynchronously, before the synchronous command transform runs.
      const named = await scanNamedWorkflows({
         workflowPaths: options.workflowPaths,
         directory: host.location.directory,
         canonicalDirectory: host.location.canonical,
       }),
       entries = parseSavedWorkflows(named),
       commandState: WorkflowCommandState = {
         entries,
         reload: () => {void ctx.command.reload()},
       },
       skill = await loadBundledSkill(),
       assertPermission = (input: LaunchPermissionInput): Promise<void> =>
         ctx.permission.assert({
           sessionID: input.sessionID,
           ...(input.agent === undefined ? {} : { agent: input.agent }),
           action: input.action,
           resources: [...input.resources],
           ...(input.save === undefined ? {} : { save: [...input.save] }),
           ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
         })

      await registerTransforms(ctx, {
        host,
        project,
        coordinator,
        options,
        bootId: coordinator.processBootId,
        longLived: isLongLivedHost(),
        commandState,
        skill,
        assertPermission,
      })

      await registerHooks(ctx, { host, project, coordinator })

      // The LAST async registration: everything after this line runs in the same tick, so the boot
      // sweep is tracked before any RPC handler can call `bootSweepSettled()`.
      const registration = await registerRunRpc(ctx, { host, coordinator })

      try {
        const activation = coordinator.activateLocation(location, rawHost, {
          config: options,
          emitRunUpdated: (view) => {
            void registration.events.emit("runUpdated", { run: view })
          },
        })
        startEventStream(ctx, { host, coordinator, activation })

        // Fire-and-forget: every stage of the boot sweep reports its own failures and never rejects.
        void bootSweep(host, project, coordinator)

        return (): void => {
          coordinator.deactivateLocation(project.projectKey, location.directory, activation.generationId, {
            graceMs: HANDOFF_GRACE_MS,
            onDisableStop: (run) => {
              // An explicit disable stops only runs registered under this exact project/location.
              void stopRun(run.runId, host, coordinator)
            },
          })
        }
      } catch (error) {
        // No await happens between registration and here, so this is only a synchronous failure.
        // Nothing was activated before `activateLocation`, and a host must not be left with a
        // handler table for a setup that never completed. A failed disposal must not mask the
        // setup error that caused the rollback.
        try {
          await registration.dispose()
        } catch {
          // Ignored: the setup error below is the one worth surfacing.
        }
        throw error
      }
    },
  })
}

const plugin = createUltraopenServer()

export default plugin
