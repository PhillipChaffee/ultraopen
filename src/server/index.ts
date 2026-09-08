import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { resolveOptions } from "./options.js"
import { registry, registry as runRegistry } from "./singleton.js"
import { installConfig } from "./ultracode/config.js"
import type { MutableConfig } from "./ultracode/config.js"
import { execute, prepare, renderFailure, WorkflowRunError } from "./tool/workflow.js"
import type { WorkflowArgs } from "./tool/workflow.js"
import { WORKFLOW_TOOL } from "./bridge/permission.js"
import { asClient } from "./types.js"
import { description } from "./tool/description.js"
import { beginRun, endRun, loadResume } from "./resume/persist.js"
import type { JournalEntry, Manifest } from "./resume/journal.js"
import { onChatMessage, onChatParams, onMessagesTransform } from "./ultracode/hooks.js"
import { mode } from "./ultracode/mode.js"
import { resolveEffort } from "./bridge/effort.js"
import { newBootId, pruneRuns, reapOrphans } from "./resume/reaper.js"
import { runDir, writeManifest, flushJournalEntry } from "./resume/store.js"
import { ProgressWriter } from "./resume/progress.js"

/**
 * The ultraopen server plugin.
 *
 * Registers the `workflow` tool and installs ultracode's activation surfaces. The TUI half is a
 * SEPARATE entry (`./tui`) with its own default export: opencode throws
 * `must default export either server() or tui(), not both` if one module exports both, and TUI
 * plugins are read only from tui.json, never from opencode.json's `plugin` array.
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
  }

  if (!nested) {
    hooks["tool"] = {
      [WORKFLOW_TOOL]: {
        description,
        args: workflowArgsSchema(),
        execute: async (args: WorkflowArgs, context: ToolContext): Promise<string> => {
          const runId = `wf_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
          // The session's default model, so `effort` resolves against ITS variant set rather
          // than a guess. A failure here is non-fatal: effort simply goes unapplied, and the run
          // log says so.
           defaultModel = await client.config
            ?.get?.()
            .then((response) => response.data?.model)
            .catch(() => undefined),

           workflowContext = {
            client,
            sessionID: context.sessionID,
            runId,
            deadlineMs: options.agentDeadlineMs,
            // Makes the schema-advertised `scriptPath` real: persisted scripts under the run
            // directory can be re-run by path.
            readScript: (path: string) => readFile(path, "utf8"),
            ...(defaultModel === undefined ? {} : { defaultModel }),
            ...(context.abort ? { signal: context.abort } : {}),
          }

          let manifest: Manifest | undefined

          // Incremental journal flush: one line per entry as it is recorded, so a process
          // killed mid-run keeps every completed agent for resume. Flushes are CHAINED
          // (appends stay in record order and never interleave) and joined before endRun,
          // so the settled rewrite can never race a floating append. The store-level flush
          // never rejects — a disk failure must not lose a live run. Declared outside the
          // try so the failure path can settle the chain too.
          let flushChain: Promise<void> = Promise.resolve()
          const flush = (entry: JournalEntry): void => {
            flushChain = flushChain.then(() => flushJournalEntry(runId, entry))
          }
          // Never rejects: flushJournalEntry cannot reject (its contract, pinned by store tests),
            // so the chain resolves once every queued append has settled.
            const settleFlushes = (): Promise<void> => flushChain

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
              },
            })

            // Resume BEFORE the run starts, so replayed calls never spawn anything.
            const resume = args.resumeFromRunId
              ? await loadResume(args.resumeFromRunId, args.args, context.sessionID)
              : undefined



            manifest = await beginRun({
              runId,
              sessionID: context.sessionID,
              source: prepared.source,
              args: args.args,
              bootId,
            })

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
              await writeManifest(runId, { ...manifest, childSessionIDs: sessions }).catch(() => undefined)
            }

            const result = await execute(args, {
              ...workflowContext,
              onProgress: (event) => {
                progress.apply(event, Date.now())
                void progress.flush()
                if (event.type === "agent-start") {void persistChildren()}
              },
              onJournal: flush,
              ...(resume && resume.entries.length > 0
                ? { previousEntries: resume.entries, resumedFrom: args.resumeFromRunId }
                : {}),
            })

            await settleFlushes()
            await endRun(manifest, {
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
            await settleFlushes()
            await endRun(manifest, {
              status: "failed",
              entries: partial?.journal ?? [],
              value: null,
              childSessionIDs: partial?.childSessionIDs ?? [],
            })
            return renderFailure(error instanceof WorkflowRunError ? error.cause : error, args.script, runId)
          }
        },
      },
    }
  }

  return hooks
}

/**
 * Renders the result for the model.
 *
 * Returns the FULL text with the summary first, deliberately uncapped: opencode already pipes
 * plugin tool output through its truncation layer, which spills the whole value to a file the
 * agent is pre-authorised to read and hands back the path. Pre-capping here would stop that spill
 * from ever firing and silently lose the tail.
 */
function renderResult(
  result: Awaited<ReturnType<typeof execute>>,
  resume?: { resumed: number; argsChanged: boolean },
): string {
  const lines = [
    `<result workflow="${result.meta.name}" run="${result.runId}" agents="${result.agentCount}">`,
    typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2),
    "</result>",
  ]

  // Never let partial coverage read as full coverage.
  if (result.nulls.length > 0) {
    lines.push(
      "",
      `<failures count="${result.nulls.length}" of="${result.agentCount}">`,
      ...result.nulls.map((entry) => `  ${entry.label}: ${entry.reason}${entry.detail ? ` — ${entry.detail}` : ""}`),
      "</failures>",
    )
  }

  if (result.logs.length > 0) {
    lines.push("", "<log>", ...result.logs.map((line) => `  ${line}`), "</log>")
  }

  // A replayed run must never read as a fresh one — the whole point of recording replays is that
  // a cached empty and a fresh empty look identical otherwise.
  if (resume?.argsChanged === true) {
    lines.push("", "<resume note=\"args changed since the previous run, so nothing was replayed\" />")
  }

  const replayed = result.journal.filter((entry) => entry.replayed === true).length
  lines.push(
    "",
    `<usage agents="${result.agentCount}" failed="${result.nulls.length}" replayed="${replayed}" ` +
      `output_tokens="${result.outputTokens}" run_dir="${runDir(result.runId)}" />`,
  )
  return lines.join("\n")
}

/**
 * The tool's argument schema, as a plain JSON-Schema-ish record.
 *
 * `title` and `description` are accepted and IGNORED, exactly as the spec specifies — a model
 * trained on Claude Code passes them, and rejecting them would surface as a validation error
 * instead of the documented silent ignore.
 */
function workflowArgsSchema(): Record<string, unknown> {
  return {
    script: { type: "string", description: "The workflow script. Must begin with `export const meta = {...}`." },
    scriptPath: { type: "string", description: "Path to a persisted script. Takes precedence over `script`." },
    args: { description: "Value exposed to the script as the global `args`. Pass real JSON, not a JSON string." },
    resumeFromRunId: {
      type: "string",
      description: "Resume a previous run from this directory's data: unchanged agent calls replay from its journal instantly, and the first changed call onward runs live.",
    },
    dryRun: { type: "boolean", description: "Run the script with agent() stubbed out, for zero tokens." },
    title: { type: "string", description: "Ignored." },
    description: { type: "string", description: "Ignored." },
  }
}

const plugin = { id: "ultraopen", server: ultraopen }

export default plugin
