import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveOptions } from "./options.js"
import type { UltraopenOptions } from "./options.js"
import { registry } from "./singleton.js"
import { installConfig } from "./ultracode/config.js"
import type { MutableConfig } from "./ultracode/config.js"
import { execute, prepare, projectLaunchSize, renderFailure, WorkflowRunError } from "./tool/workflow.js"
import type { WorkflowArgs } from "./tool/workflow.js"
import { WORKFLOW_TOOL, STATUS_TOOL } from "./bridge/permission.js"
import { asClient } from "./types.js"
import type { OpencodeClient } from "./types.js"
import { description, blockingDescription, longLivedDescription, statusDescription, withSizeAdvice } from "./tool/description.js"
import {
  liveRunsForSession,
  siblingRunsForSession,
  isLiveAnywhere,
  isLongLivedHost,
  registerPending,
  nameRun,
  dropPending,
  dropSettled,
  stopRun,
  onSessionIdle,
} from "./tool/background.js"

import { executeStatus } from "./tool/status.js"
import type { StatusArgs } from "./tool/status.js"
import {
  renderResult,
  renderLaunch,
  renderRefusal,
  renderCapRefusal,
  renderResumeRefusal,
  renderStatus,
  workflowArgsSchema,
  statusArgsSchema,
} from "./tool/render.js"
import { listSavedWorkflows, scanNamedWorkflows } from "./tool/named.js"
import { wireRun, startDetachedRun } from "./tool/settlement.js"
import type { SettleOutcome } from "./tool/settlement.js"
import { beginRun, loadResume } from "./resume/persist.js"
import { ensureRunDir, isSafeRunId, readManifest, writeScript } from "./resume/store.js"
import type { JournalEntry, Manifest } from "./resume/journal.js"
import { onChatMessage, onChatParams, onMessagesTransform } from "./ultracode/hooks.js"
import { mode } from "./ultracode/mode.js"
import { resolveEffort } from "./bridge/effort.js"
import { newBootId, pruneRuns, reapOrphans } from "./resume/reaper.js"
import { resumeInterruptedRuns } from "./resume/autoresume.js"

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
  /**
   * The driving agent's name, delivered by the host on the tool-execute context
   * (verified against opencode 1.18.31 — packages/plugin/src/tool.ts). It is the
   * `ultracode` agent's activation surface for the launch gate.
   */
  agent?: string
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
  mode.setKeywordBehavior(options.keywordBehavior)

  // Decided once from the process shape: it picks which launch contract the
  // tool description and every launch result serve (see tool/background.ts).
  const longLived = isLongLivedHost()

  // One sync scan at load builds the /workflow-<name> commands. The RUN path
  // rescans per tool call (a file saved mid-session runs at once); only the
  // command surface waits for the next start, because the config hook is
  // synchronous by contract.
  const savedWorkflows = listSavedWorkflows({
    workflowPaths: options.workflowPaths,
    directory: input.directory,
  })

  // One boot id per process. Runs still marked `running` under a DIFFERENT boot id belonged to a
  // process that died, and their subagents are still alive and billing — opencode never cascades
  // an abort to plain parentID children. Swept in the background so plugin init is never blocked
  // by a slow or unreachable server.
  const bootId = newBootId()
  // No .catch(): every stage of the boot sweep is contractually non-throwing (every I/O failure
  // is swallowed and reported in its result), and an unreachable handler here would be untestable
  // defensive code.
  void bootSweep(client, bootId, options, input.directory)

  const hooks: Record<string, unknown> = {
    /**
     * Mutates the live config object. The return value is discarded — mutation is the only
     * channel — and this MUST NOT await anything on `input.client` first: a client call re-enters
     * the HTTP server and can materialise the agent list from the not-yet-mutated config,
     * permanently caching an agent list without `ultracode` for this instance's lifetime.
     */
    config: (config: MutableConfig): void => {
      // Resolved from this module's own location so it works from node_modules or a file spec.
      installConfig(config, {
        skillsPath: join(import.meta.dirname, "..", "skills"),
        workflowCommands: savedWorkflows,
      })
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
     * Feeds the idle deadline's activity map, and drives the hydration idle nudge.
     *
     * Every live message update touches the emitting child's last-activity stamp. Bus events are
     * the only progress signal that covers schema'd children: `format` poisons the REST message
     * listing, but part events are emitted live regardless. Touching is scoped to engine-owned
     * sessions, so the user's own sessions never inflate the map.
     *
     * `session.idle` (captured v1.18.31: `{ type: "session.idle", properties: { sessionID } }`,
     * deprecated upstream but still published) arms the missed-wake nudge for a session whose
     * last word is an unanswered hydration notification. Fire-and-forget: the hook is synchronous
     * by contract and must never reject.
     */
    event: (hookInput: { event?: { type?: string; properties?: { part?: { sessionID?: string }; info?: { sessionID?: string }; sessionID?: string } } }): void => {
      const event = hookInput?.event
      if (event?.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (sessionID !== undefined) {void onSessionIdle(client, sessionID)}
        return
      }
      if (event?.type !== "message.part.updated" && event?.type !== "message.updated") {return}
      const sessionID = event.properties?.part?.sessionID ?? event.properties?.info?.sessionID
      if (sessionID !== undefined) {registry.touchActivity(sessionID)}
    },
  }

  if (!nested) {
    hooks["tool"] = {
      [WORKFLOW_TOOL]: {
        description: toolDescription(options, longLived),
        args: workflowArgsSchema(),
        execute: (args: WorkflowArgs, context: ToolContext): Promise<string> =>
          launchWorkflow(args, context, options, client, bootId, input.directory, longLived),
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
 * The tool description for this instance's contract and configured size advice.
 *
 * Blocking is the explicit option (and the env kill switch); otherwise the host
 * decides which background contract the model reads (see tool/background.ts).
 */
function toolDescription(options: UltraopenOptions, longLived: boolean): string {
  if (options.runMode === "blocking") {return blockingDescription}
  const base = longLived ? longLivedDescription : description
  if (options.sizeGuideline === undefined) {return base}
  return withSizeAdvice(base, options.sizeGuideline)
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
  projectDirectory: string | undefined,
  longLived: boolean,
): Promise<string> {
  // The stop path short-circuits BEFORE the launch gate: a session with a live run must be able to stop it.
  // An EMPTY stop value is a launch default, not a stop request — models emit optional fields as "".
  if (args.stop !== undefined && args.stop !== "") {return await stopRun({ runId: args.stop, client, bootId })}

  const background = args.dryRun !== true && (args.background ?? options.runMode === "background"),
   runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
   // The session's default model, so `effort` resolves against ITS variant set rather
   // than a guess. A failure here is non-fatal: effort simply goes unapplied, and the run
   // log says so.
   defaultModel = await client.config
    ?.get?.()
    .then((response) => response.data?.model)
    .catch(() => undefined)

  // Saved workflows resolve from disk on every call: a file saved mid-session
  // runs by name at once, and no cached map can drift from what is on disk.
  const scanNotes: string[] = [],
   named = await scanNamedWorkflows({
    workflowPaths: options.workflowPaths,
    directory: projectDirectory,
    onNote: (note) => scanNotes.push(note),
  }),
   scanNoteLines = scanNotes.length > 0 ? ["", "<scan-notes>", ...scanNotes, "</scan-notes>"] : []

  // One live run per session for non-ultracode sessions, for BOTH contracts (see
  // lifecycle-policy.md): a blocking call inside a turn serializes itself anyway,
  // but mixed contracts would put two agent-spending runs in one session. dryRun
  // is exempt — it is free, stubbed, and the standard way to debug a script
  // mid-run. Ultracode-active sessions (policy: docs/adr/0001-launch-concurrency-policy.md)
  // bypass that refusal up to the live-run cap `ultracodeMaxRuns` — a launch at
  // the cap is refused naming every live run — and demotion never changes the
  // gate: it is prompt-level guidance only. Both contracts register: the resume
  // gate defers to this registry on the same boot (isLiveAnywhere), so a
  // blocking run invisible here would let a same-boot resume run two engines
  // against one journal. Launch-gating state is registered SYNCHRONOUSLY, before
  // the first await, so two calls from one session in the same tick cannot both
  // pass the refusal check (the check-then-act race). Every early return below
  // must drop it.
  if (args.dryRun !== true) {
    const live = liveRunsForSession(context.sessionID)
    if (mode.isActive(context.sessionID, context.agent)) {
      if (live.length >= options.ultracodeMaxRuns) {return renderCapRefusal(live, options.ultracodeMaxRuns)}
    } else {
      const [oldest] = live
      if (oldest) {return renderRefusal(oldest)}
    }
    registerPending(runId, context.sessionID)
  }

  try {
    // Parse BEFORE asking, so the permission prompt names the real workflow and can show
    // what it intends to do. `meta` is a pure literal specifically so it can be read
    // without running anything. Using the tool's `title` argument here instead would be
    // wrong twice over: it is documented as ignored, and the model usually omits it.
    const prepared = await prepare(args, {
      client,
      sessionID: context.sessionID,
      runId,
      // Makes the schema-advertised `scriptPath` real: persisted scripts under the run
      // directory can be re-run by path.
      readScript: (path: string) => readFile(path, "utf8"),
    })

    // The per-turn live-run reminder names the workflow, and prepare() is where the name is
    // first known — recorded before the ask so even a pending entry carries it.
    nameRun(runId, prepared.meta.name)

    // Persist the script BEFORE the ask, so the user can open the real file
    // while the prompt is on screen. beginRun writes it again (same bytes) when
    // the run starts; an approved run therefore cannot desync. The run
    // directory must exist for the write — created here, best-effort like the
    // write itself: a failed write must not block the prompt, and a failure
    // here resurfaces through beginRun's friendly launch-failure message.
    await ensureRunDir(runId).catch(() => undefined)
    await writeScript(runId, prepared.source).catch(() => undefined)

    // A resume that will be refused is refused BEFORE the permission ask: a call
    // with a malformed resumeFromRunId, or one whose source run is live elsewhere,
    // would otherwise render the approval dialog, consume the user's approval, and
    // only then refuse — nothing launches, and the approval is spent (the burned
    // approval also cascades into a re-ask chain, since models retry after the
    // refusal). The journal rationale still holds: two writers on one journal
    // would interleave appends and race the endRun rewrite.
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

    // `always` is scoped to this workflow's name rather than "*": an "always" grant is
    // stored instance-wide, so approving once with "*" would permanently disable the
    // prompt for every workflow in the directory.
    //
    // Before the ask, a free IN-MEMORY projection of the fresh-run fan-out: the prompt
    // names what approving costs, and a large projected fan-out is flagged so an
    // unattended launch can be caught before it spends. projectLaunchSize degrades any
    // projection failure to undefined — advisory, never a gate. A dry run is its own
    // free preview, so the pass is skipped for it.
    const projectedAgents = args.dryRun === true
      ? undefined
      : await projectLaunchSize(prepared, args, named, { signal: context.abort })

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
        ...(projectedAgents === undefined ? {} : { projectedAgents }),
        ...(projectedAgents !== undefined && projectedAgents >= options.largeWorkflowAgents ? { largeWorkflow: true } : {}),
      },
    })

    // Resume BEFORE the run starts, so replayed calls never spawn anything; the
    // refusal gates above already cleared a live source run.
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

    // The shared execution wiring — flush chain, progress writer with crash-safe child
    // persistence, run-control channel, and the ONE settle protocol — is assembled by
    // tool/settlement.ts so the detached auto-resume path reuses it verbatim.
    const shared = {
      runId,
      client,
      sessionID: context.sessionID,
      manifest,
      prepared,
      args,
      options,
      named: Object.keys(named).length > 0 ? named : undefined,
      ...(defaultModel === undefined ? {} : { defaultModel }),
      previousEntries: resume?.entries,
      resumedFrom: args.resumeFromRunId,
      resume: { resumed: resume?.entries.length ?? 0, argsChanged: resume?.argsChanged === true },
    }

    if (!background) {
      // The blocking contract waits for the run and takes the tool call's abort signal: a
      // parent-turn interrupt unwinds the script it is waiting on.
      const wiring = wireRun({ ...shared, signal: context.abort })
      const result = await runBlocking(args, { runId, manifest, resume, executeContext: wiring.executeContext, settleRun: wiring.settle, budgetTokens: options.budgetTokens })
      return [result, ...scanNoteLines].join("\n")
    }

    // Detached: the run outlives this tool call. The task fully captures its own
    // outcome — flushes, manifest, failure text — because nothing else is
    // waiting on it anymore; startDetachedRun owns the stop controller the
    // stop path trips.
    startDetachedRun(shared)

    const projection = projectedAgents === undefined ? undefined : { agents: projectedAgents, threshold: options.largeWorkflowAgents }
    return [renderLaunch(prepared.meta.name, runId, longLived, siblingRunsForSession(context.sessionID, runId), projection, options.budgetTokens), ...scanNoteLines].join("\n")
  } catch (error) {
    // Reached only by the launch phase itself: a parse failure or a rejected
    // permission ask. The run never went live, so the pending entry is dropped.
    dropPending(runId)
    return renderFailure(error, args.script, runId)
  }
}

/** The shared settle protocol's signature; the ONE settle protocol lives in tool/settlement.ts. */
type SettleRun = (outcome: SettleOutcome) => Promise<void>

interface BlockingRun {
  runId: string
  manifest: Manifest
  resume: { entries: JournalEntry[]; argsChanged: boolean } | undefined
  executeContext: Parameters<typeof execute>[1]
  settleRun: SettleRun
  /** The plugin's per-run ceiling, for the blocking result's budget statement. */
  budgetTokens: number | null
}

/**
 * The blocking contract: wait for the run, then return one consolidated result.
 *
 * Kept behaviorally identical to the pre-async tool — it is the documented kill
 * switch (`runMode: "blocking"` / `ULTRAOPEN_WORKFLOW_SYNC=1`) and the dry-run
 * path. Its launch registered at the session gate like every other launch; the
 * finally drops that entry only after the settle protocol completed, so the
 * resume gate stays closed while the settle is writing and the next launch
 * finds no residue once it is done.
 */
async function runBlocking(args: WorkflowArgs, run: BlockingRun): Promise<string> {
  const { runId, manifest, resume, executeContext, settleRun, budgetTokens } = run
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
    // The own entry is still registered at render time (the finally below drops
    // it after the settle protocol), so the query excludes this run by id.
    return renderResult(result, {
      resumed: resume?.entries.length ?? 0,
      argsChanged: resume?.argsChanged === true,
    }, siblingRunsForSession(manifest.sessionID, runId), budgetTokens)
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
  } finally {
    // Settled, whatever the outcome. The drop waits for the settle protocol
    // (no resume may pass while the manifest is still being closed) and deletes
    // unconditionally: a status-guarded drop could strand the gate.
    dropSettled(runId)
  }
}

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
 * Fire-and-forget like every boot-time persistence: no stage rejects, so plugin init never waits
 * on a slow or unreachable server and no caller needs a catch.
 */
async function bootSweep(
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

const plugin = { id: "ultraopen", server: ultraopen }

export default plugin