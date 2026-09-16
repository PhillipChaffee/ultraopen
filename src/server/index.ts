import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveOptions } from "./options.js"
import type { UltraopenOptions } from "./options.js"
import { registry, registry as runRegistry } from "./singleton.js"
import { installConfig } from "./ultracode/config.js"
import type { MutableConfig } from "./ultracode/config.js"
import { execute, prepare, renderFailure, WorkflowRunError } from "./tool/workflow.js"
import type { WorkflowArgs, WorkflowContext } from "./tool/workflow.js"
import { WORKFLOW_TOOL, STATUS_TOOL } from "./bridge/permission.js"
import { asClient } from "./types.js"
import type { OpencodeClient } from "./types.js"
import { description, blockingDescription, statusDescription } from "./tool/description.js"
import {
  activeRunForSession,
  isLiveAnywhere,
  registerPending,
  dropPending,
  runDetached,
} from "./tool/background.js"
import { executeStatus } from "./tool/status.js"
import type { StatusArgs } from "./tool/status.js"
import {
  renderResult,
  renderLaunch,
  renderRefusal,
  renderResumeRefusal,
  renderStatus,
  workflowArgsSchema,
  statusArgsSchema,
} from "./tool/render.js"
import { beginRun, endRun, loadResume } from "./resume/persist.js"
import { isSafeRunId, readManifest, writeManifest, flushJournalEntry, writeFailure } from "./resume/store.js"
import type { JournalEntry, Manifest } from "./resume/journal.js"
import { onChatMessage, onChatParams, onMessagesTransform } from "./ultracode/hooks.js"
import { mode } from "./ultracode/mode.js"
import { resolveEffort } from "./bridge/effort.js"
import { newBootId, pruneRuns, reapOrphans } from "./resume/reaper.js"
import { ProgressWriter } from "./resume/progress.js"

/**
 * The ultraopen server plugin.
 *
 * Registers the `workflow` and `workflow_status` tools and installs ultracode's activation
 * surfaces. The TUI half is a SEPARATE entry (`./tui`) with its own default export: opencode
 * throws `must default export either server() or tui(), not both` if one module exports both, and
 * TUI plugins are read only from tui.json, never from opencode.json's `plugin` array.
 */

interface ToolContext {
  sessionID: string
  messageID?: string
  abort?: AbortSignal
  ask?: (input: { permission: string; patterns: string[]; always: string[]; metadata?: unknown }) => Promise<void>
}

interface PluginInput {
  client: unknown
  directory?: string
  worktree?: string
}

interface ShellEnvOutput { env: Record<string, string> }

/** Set in every engine-owned child's shell environment. */
const ACTIVE_ENV = "ULTRAOPEN_ACTIVE"

export function ultraopen(input: PluginInput, rawOptions?: unknown): Record<string, unknown> {
  const options = resolveOptions(rawOptions),
   client = asClient(input.client),

  // A nested `opencode` process would get a fresh server, a fresh plugin load and a fresh tool,
  // escaping this process's concurrency cap, agent counter, budget and abort signal entirely.
  // Refusing to register the tool at all is the one guard that survives every path a command
  // pattern cannot match (`/usr/local/bin/opencode`, `sh -c '...'`, `env FOO=1 opencode`).
   nested = process.env[ACTIVE_ENV] === "1"

  registry.configureConcurrency(options.concurrency)
  mode.setDefault(options.ultracode)

  // One boot id per process. Runs still marked `running` under a DIFFERENT boot id belonged to a
  // process that died, and their subagents are still alive and billing — opencode never cascades
  // an abort to plain parentID children. Swept in the background so plugin init is never blocked
  // by a slow or unreachable server.
  const bootId = newBootId()
  // No .catch(): reapOrphans is contractually non-throwing (every I/O failure is swallowed and
  // reported in its result), and an unreachable handler here would be untestable defensive code.
  void reapOrphans(client, bootId, {})
  // Same fire-and-forget contract. Runs still on disk past the retention window are pruned after
  // the reaper marks any interrupted ones, so a just-orphaned run is not deleted mid-sweep.
  void pruneRuns({})

  const hooks: Record<string, unknown> = {
    /**
     * Mutates the live config object. The return value is discarded — mutation is the only
     * channel — and this MUST NOT await anything on `input.client` first: a client call re-enters
     * the HTTP server and can materialise the agent list from the not-yet-mutated config,
     * permanently caching an agent list without `ultracode` for this instance's lifetime.
     */
    config: (config: MutableConfig): void => {
      // Resolved from this module's own location so it works from node_modules or a file spec.
      installConfig(config, { skillsPath: join(import.meta.dirname, "..", "skills") })
    },

    /**
     * Detects the `ultracode` keyword and any instruction to stop fanning out, and raises the
     * effort on the parent turn. Deliberately does NOT write parts: those are persisted, so a
     * reminder here would accumulate one copy per user turn forever.
     */
    "chat.message": (
      hookInput: Parameters<typeof onChatMessage>[0],
      output: Parameters<typeof onChatMessage>[1],
    ): void => {
      onChatMessage(hookInput, output, {
        resolveVariant: (effort) => resolveEffort(effort, { available: [] }).variant,
      })
    },

    /**
     * Injects the per-turn reminder. This hook operates on messages re-read from the database each
     * step, so what it adds is ephemeral — unlike chat.message's parts.
     */
    "experimental.chat.messages.transform": (
      _input: unknown,
      output: Parameters<typeof onMessagesTransform>[0],
    ): void => {
      onMessagesTransform(output)
    },

    /** Belt-and-braces effort raise, read at a different point than the message variant. */
    "chat.params": (
      hookInput: Parameters<typeof onChatParams>[0],
      output: Parameters<typeof onChatParams>[1],
    ): void => {
      onChatParams(hookInput, output, {
        resolveVariant: (effort, available) => resolveEffort(effort, { available }).variant,
      })
    },

    /**
     * Turns the mode on when the user runs `/ultracode`.
     *
     * Fires before the prompt is built, so the same turn already sees the reminder.
     */
    "command.execute.before": (hookInput: { command: string; sessionID: string; arguments?: string }): void => {
      if (hookInput.command !== "ultracode") {return}
      // Case-insensitive: `/ultracode OFF` must not silently re-enable what the user asked to stop.
      if (hookInput.arguments?.trim().toLowerCase() === "off") {mode.disable(hookInput.sessionID)}
      else {mode.enable(hookInput.sessionID, "command")}
    },

    /**
     * Marks shells inside engine-owned sessions, scoped so ordinary sessions are unaffected.
     * Scoping matters: a blanket marker would disable the tool for the user's own work too.
     */
    "shell.env": (hookInput: { sessionID?: string }, output: ShellEnvOutput): void => {
      if (hookInput.sessionID && registry.owns(hookInput.sessionID)) {output.env[ACTIVE_ENV] = "1"}
    },

    /**
     * Feeds the idle deadline's activity map.
     *
     * Every live message update touches the emitting child's last-activity stamp. Bus events are
     * the only progress signal that covers schema'd children: `format` poisons the REST message
     * listing, but part events are emitted live regardless. Touching is scoped to engine-owned
     * sessions, so the user's own sessions never inflate the map.
     */
    event: (hookInput: { event?: { type?: string; properties?: { part?: { sessionID?: string }; info?: { sessionID?: string } } } }): void => {
      const event = hookInput?.event
      if (event?.type !== "message.part.updated" && event?.type !== "message.updated") {return}
      const sessionID = event.properties?.part?.sessionID ?? event.properties?.info?.sessionID
      if (sessionID !== undefined) {registry.touchActivity(sessionID)}
    },
  }

  if (!nested) {
    hooks["tool"] = {
      [WORKFLOW_TOOL]: {
        description: options.runMode === "blocking" ? blockingDescription : description,
        args: workflowArgsSchema(),
        execute: (args: WorkflowArgs, context: ToolContext): Promise<string> =>
          launchWorkflow(args, context, options, client, bootId),
      },
      [STATUS_TOOL]: {
        description: statusDescription,
        args: statusArgsSchema(),
        execute: async (args: StatusArgs, context: ToolContext): Promise<string> => {
          try {
            return renderStatus(await executeStatus(args, { bootId, signal: context.abort }))
          } catch (error) {
            // An unknown or malformed run id is a clear error for the model, never a crash.
            return error instanceof Error ? error.message : String(error)
          }
        },
      },
    }
  }

  return hooks
}

/**
 * Launches one workflow run.
 *
 * Two contracts share this path. `background` — the default — returns the run id
 * at once and hands the run to a detached task, so the session stays free while
 * the run works; `blocking` waits for the final result, for one-shot hosts that
 * kill the process after the turn (see tasks/async-runs/notes/host-lifecycle-facts.md).
 * `dryRun` always blocks: it is free, finishes in milliseconds, and its whole
 * point is the fan-out preview inside the result.
 */
async function launchWorkflow(
  args: WorkflowArgs,
  context: ToolContext,
  options: UltraopenOptions,
  client: OpencodeClient,
  bootId: string,
): Promise<string> {
  const background = args.dryRun !== true && (args.background ?? options.runMode === "background"),
   runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
   // The session's default model, so `effort` resolves against ITS variant set rather
   // than a guess. A failure here is non-fatal: effort simply goes unapplied, and the run
   // log says so.
   defaultModel = await client.config
    ?.get?.()
    .then((response) => response.data?.model)
    .catch(() => undefined),

   workflowContext: WorkflowContext = {
    client,
    sessionID: context.sessionID,
    runId,
    deadlineMs: options.agentDeadlineMs,
    idleMs: options.agentIdleMs,
    // Makes the schema-advertised `scriptPath` real: persisted scripts under the run
    // directory can be re-run by path.
    readScript: (path: string) => readFile(path, "utf8"),
    ...(defaultModel === undefined ? {} : { defaultModel }),
    // The detached run must NOT take the tool call's signal: a parent-turn
    // interrupt would otherwise kill the run it just launched. The signal is a
    // launch-phase concern; only the blocking contract still threads it into
    // the Run, where aborting the call and aborting the run are the same act.
    ...(!background && context.abort ? { signal: context.abort } : {}),
  }

  // One live run per session, for BOTH contracts (see lifecycle-policy.md): a
  // blocking call inside a turn serializes itself anyway, but mixed contracts
  // would put two agent-spending runs in one session. dryRun is exempt — it is
  // free, stubbed, and the standard way to debug a script mid-run. Launch-gating
  // state is registered SYNCHRONOUSLY, before the first await, so two calls from
  // one session in the same tick cannot both pass the refusal check (the
  // check-then-act race). Every early return below must drop it.
  if (args.dryRun !== true) {
    const active = activeRunForSession(context.sessionID)
    if (active) {return renderRefusal(active)}
    if (background) {registerPending(runId, context.sessionID)}
  }

  // Incremental journal flush: one line per entry as it is recorded, so a process
  // killed mid-run keeps every completed agent for resume. Flushes are CHAINED
  // (appends stay in record order and never interleave) and joined before endRun,
  // so the settled rewrite can never race a floating append. The store-level flush
  // never rejects — a disk failure must not lose a live run.
  let flushChain: Promise<void> = Promise.resolve()
  const flush = (entry: JournalEntry): void => {
    flushChain = flushChain.then(() => flushJournalEntry(runId, entry))
  }

  try {
    // Parse BEFORE asking, so the permission prompt names the real workflow and can show
    // what it intends to do. `meta` is a pure literal specifically so it can be read
    // without running anything. Using the tool's `title` argument here instead would be
    // wrong twice over: it is documented as ignored, and the model usually omits it.
    const prepared = await prepare(args, workflowContext)

    // `always` is scoped to this workflow's name rather than "*": an "always" grant is
    // stored instance-wide, so approving once with "*" would permanently disable the
    // prompt for every workflow in the directory.
    await context.ask?.({
      permission: WORKFLOW_TOOL,
      patterns: [prepared.meta.name],
      always: [prepared.meta.name],
      metadata: {
        runId,
        name: prepared.meta.name,
        description: prepared.meta.description,
        phases: prepared.meta.phases?.map((phase) => phase.title) ?? [],
        dryRun: args.dryRun === true,
        background,
      },
    })

    // Resume BEFORE the run starts, so replayed calls never spawn anything. A
    // resume whose source run is still being written by a live Run (this boot
    // or another) is refused first: two writers on one journal would interleave
    // appends and race the endRun rewrite.
    if (args.resumeFromRunId) {
      // The id is model-supplied input and joins into a filesystem path below,
      // exactly like the status tool's runId: rejected before any read.
      if (!isSafeRunId(args.resumeFromRunId)) {
        dropPending(runId)
        return renderResumeRefusal(args.resumeFromRunId, undefined)
      }
      const source = await readManifest(args.resumeFromRunId)
      if (source && isLiveAnywhere(source, bootId)) {
        dropPending(runId)
        return renderResumeRefusal(source.runId, source.pid)
      }
    }
    const resume = args.resumeFromRunId
      ? await loadResume(args.resumeFromRunId, args.args, context.sessionID)
      : undefined

    // The manifest MUST be on disk before this call returns: the launch result
    // names a run id that `workflow_status` has to resolve, and a run without a
    // manifest is invisible to the status tool and to the reaper. A beginRun
    // failure therefore aborts the launch rather than starting a run that could
    // never be reported on.
    const manifest = await beginRun({
      runId,
      sessionID: context.sessionID,
      source: prepared.source,
      args: args.args,
      bootId,
    })
    if (!manifest) {
      dropPending(runId)
      return "The workflow could not be started: its run directory could not be created. " +
        "Nothing was executed and no tokens were spent."
    }

    /**
     * The ONE settle protocol for both contracts: join the flush chain, close
     * the manifest, and persist failure text when there is any. Extracted
     * because the ordering (flushes settle BEFORE the endRun rewrite, so the
     * settled write can never race a floating append) is crash-safety, not
     * style — the escaped-rejection fallback below must obey it too.
     */
    const settleRun = async (outcome: {
      status: "completed" | "failed"
      entries: readonly JournalEntry[]
      value: unknown
      childSessionIDs: string[]
      failureText?: string | undefined
    }): Promise<void> => {
      // The chain variable is read live: appends queued before this await are
      // included, however long the chain grew.
      await flushChain
      await endRun(manifest, outcome)
      if (outcome.failureText !== undefined) {
        // Best-effort like every persistence here: a failed write must not
        // lose the settle itself.
        try {await writeFailure(runId, outcome.failureText)} catch {
          // Best-effort: a failed write must not lose the settle itself.
        }
      }
    }

    const progress = new ProgressWriter({
      runId,
      workflow: prepared.meta.name,
      sessionID: context.sessionID,
      startedAt: Date.now(),
    })

    // Crash safety: the manifest's child list is updated as sessions appear, so a server
    // killed mid-run still leaves the reaper a list of children to abort. Written per
    // agent-start (not per event) to keep the I/O bounded by agent count.
    let persistedChildren = -1
    const persistChildren = async (): Promise<void> => {
      if (!manifest) {return}
      const sessions = runRegistry.sessionsOf(runId)
      if (sessions.length === persistedChildren) {return}
      persistedChildren = sessions.length
      try {await writeManifest(runId, { ...manifest, childSessionIDs: sessions })} catch {
        // Crash safety is best-effort: a failed manifest rewrite must not stall the run.
      }
    }

    const executeContext = {
      ...workflowContext,
      onProgress: (event: Parameters<ProgressWriter["apply"]>[0]) => {
        progress.apply(event, Date.now())
        void progress.flush()
        // Persist on agent-start AND on log lines: a stall restart spawns a NEW child
        // session without an agent-start, and a killed server must leave the reaper a
        // list that includes it. persistChildren no-ops when the list is unchanged, so
        // narration-heavy runs cost no extra writes.
        if (event.type === "agent-start" || event.type === "log") {void persistChildren()}
      },
      onJournal: flush,
      ...(resume && resume.entries.length > 0
        ? { previousEntries: resume.entries, resumedFrom: args.resumeFromRunId }
        : {}),
    }

    if (!background) {
      return await runBlocking(args, { runId, manifest, resume, executeContext, settleRun })
    }

    // Detached: the run outlives this tool call. The task fully captures its own
    // outcome — flushes, manifest, failure text — because nothing else is
    // waiting on it anymore.
    void runDetached({
      runId,
      task: async (): Promise<void> => {
        try {
          const result = await execute(args, executeContext)
          await settleRun({
            status: "completed",
            entries: result.journal,
            value: result.value,
            // Captured inside the run before its cleanup forgot the sessions — reading the
            // registry here would always yield [].
            childSessionIDs: result.childSessionIDs,
          })
        } catch (error) {
          const partial = error instanceof WorkflowRunError ? error.partial : undefined
          await settleRun({
            status: "failed",
            entries: partial?.journal ?? [],
            value: null,
            childSessionIDs: partial?.childSessionIDs ?? [],
            failureText: renderFailure(error instanceof WorkflowRunError ? error.cause : error, args.script, runId),
          })
        }
      },
      // Last resort: the task above is contractually self-capturing, so an
      // escaping rejection means its own failure path broke. Route through the
      // same settle protocol — including the flush join — so the degraded
      // record still follows the crash-safety ordering.
      onEscapedRejection: (error): Promise<void> =>
        settleRun({
          status: "failed",
          entries: [],
          value: null,
          childSessionIDs: [],
          failureText: renderFailure(error, args.script, runId),
        }),
    })

    return renderLaunch(prepared.meta.name, runId)
  } catch (error) {
    // Reached only by the launch phase itself: a parse failure or a rejected
    // permission ask. The run never went live, so the pending entry is dropped.
    dropPending(runId)
    return renderFailure(error, args.script, runId)
  }
}

/** The shared settle protocol's signature; see settleRun inside launchWorkflow. */
type SettleRun = (outcome: {
  status: "completed" | "failed"
  entries: readonly JournalEntry[]
  value: unknown
  childSessionIDs: string[]
  failureText?: string | undefined
}) => Promise<void>

interface BlockingRun {
  runId: string
  manifest: Manifest
  resume: { entries: JournalEntry[]; argsChanged: boolean } | undefined
  executeContext: Parameters<typeof execute>[1]
  settleRun: SettleRun
}

/**
 * The blocking contract: wait for the run, then return one consolidated result.
 *
 * Kept behaviorally identical to the pre-async tool — it is the documented kill
 * switch (`runMode: "blocking"` / `ULTRAOPEN_WORKFLOW_SYNC=1`) and the dry-run
 * path.
 */
async function runBlocking(args: WorkflowArgs, run: BlockingRun): Promise<string> {
  const { runId, resume, executeContext, settleRun } = run
  try {
    const result = await execute(args, executeContext)
    await settleRun({
      status: "completed",
      entries: result.journal,
      value: result.value,
      // Captured inside the run before its cleanup forgot the sessions — reading the
      // registry here would always yield [].
      childSessionIDs: result.childSessionIDs,
    })
    return renderResult(result, {
      resumed: resume?.entries.length ?? 0,
      argsChanged: resume?.argsChanged === true,
    })
  } catch (error) {
    const partial = error instanceof WorkflowRunError ? error.partial : undefined
    await settleRun({
      status: "failed",
      entries: partial?.journal ?? [],
      value: null,
      childSessionIDs: partial?.childSessionIDs ?? [],
      // The blocking contract renders the failure as the tool result, the way
      // the pre-async tool did; failure.txt is the detached contract's channel.
    })
    return renderFailure(error instanceof WorkflowRunError ? error.cause : error, args.script, runId)
  }
}

const plugin = { id: "ultraopen", server: ultraopen }

export default plugin