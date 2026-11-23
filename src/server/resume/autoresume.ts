import { readFile, realpath, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { HostPort } from "../host/port.js"
import { createAncestorLookup } from "../bridge/permission.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../runtime/coordinator.js"
import { isStopAbortDetail } from "./journal.js"
import { nameRun, registerPending } from "../tool/background.js"
import { startDetachedRun } from "../tool/settlement.js"
import { nativeAncestorSessionIDs } from "../tool/launch.js"
import { prepare } from "../tool/workflow.js"
import type { execute, PreparedWorkflow } from "../tool/workflow.js"
import { inspectArgsTransport } from "../tool/args-transport.js"
import { scanNamedWorkflows } from "../tool/named.js"
import type { Manifest } from "./journal.js"
import { loadResume } from "./persist.js"
import { INTERRUPTED_MARKER, isProcessAlive, readJournal, runDir, writeManifest } from "./store.js"

/**
 * Auto-resume-on-boot: re-execute the runs a process death interrupted.
 *
 * The reaper has already stopped the orphaned children and harvested the interrupted manifests;
 * this sweep decides, run by run, whether the interrupted work should continue. The journal
 * survives process death by construction, so the resume replays every completed agent instantly
 * and re-runs only the missing tail — with the ORIGINAL run id, because journal continuity lives
 * in that run directory.
 *
 * Every decision is a policy guard, each testable:
 *   - the run's pid must be dead;
 *   - the interruption must be younger than `autoResumeTtlHours`;
 *   - the stored args must still hash to the manifest's `argsHash`;
 *   - the run must belong to THIS project (`#175`): manifest `projectID` owns it, with the live
 *     session's project as the fallback for a pre-upgrade manifest, and a recorded `directory`
 *     that resolves to the host's canonical root counts as the same project (a directory alias
 *     must not orphan a run the way `/var` vs `/private/var` did in T12);
 *   - the parent session must still exist AND its agent must resolve — the session row may name
 *     none, in which case the host's default primary agent is the one the child permission chain
 *     would use — or adoption fails closed (`#149` #7);
 *   - stopped runs never resume;
 *   - at most `autoResumeMax` runs adopt per boot, oldest interruption first.
 *
 * Adoption is claimed by RENAMING the reaper's `interrupted.txt` marker — an atomic
 * same-filesystem test-and-set — so two processes booting at once cannot both execute one
 * journal. The manifest is re-stamped BEFORE executing, so a second restart during a resume
 * re-orphans the run instead of double-adopting it.
 */

/** The claimed marker's name between the rename and the re-stamp. */
const CLAIM_MARKER = "resuming.txt"

/**
 * Resolves a recorded directory to its physical path, so `/var/...` and `/private/var/...`
 * aliases compare equal across processes (T12). A path that no longer exists falls back to its
 * lexical form, which still matches an identical recorded string.
 */
async function physicalPath(path: string | undefined): Promise<string | undefined> {
  if (path === undefined || path.trim() === "") {return undefined}
  try {return await realpath(path)} catch {return resolve(path)}
}

export interface AutoResumeResult {
  /** Run ids that were adopted and re-executed. */
  resumed: string[]
  /** Candidates skipped by a guard (TTL, argsChanged, project, session, agent, stop, cap, veto). */
  skipped: number
  /** Candidates whose adoption itself failed (re-stamp unwritable). */
  failed: number
}

export interface AutoResumeOptions {
  /** The sweep's boot identity; the coordinator's process boot id is authoritative. */
  bootId?: string | undefined
  /** Freshly-orphaned manifests from this boot's reap, in reaper order. */
  candidates: readonly Manifest[]
  /** Project directory, for saved-workflow resolution of nested `workflow("name")` calls. */
  directory?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  /** Injectable for tests. */
  now?: number | undefined
  /** Injectable for tests. */
  isProcessAlive?: ((pid: number) => boolean) | undefined
  /** Injectable engine for tests, passed through to the detached task. */
  executeFn?: typeof execute | undefined
  onNote?: ((note: string) => void) | undefined
}

/**
 * Resumes interrupted runs within the policy guards. NEVER REJECTS — every per-run failure is
 * swallowed and counted, like the reaper's sweep it follows, so callers can fire-and-forget.
 */
export async function resumeInterruptedRuns(
  host: HostPort,
  project: ProjectRuntime,
  coordinator: RuntimeCoordinator,
  options: AutoResumeOptions,
): Promise<AutoResumeResult> {
  const { candidates, env } = options,
   config = project.options,
   alive = options.isProcessAlive ?? isProcessAlive,
   now = options.now ?? Date.now(),
   ttlMs = config.autoResumeTtlHours * 60 * 60 * 1000,
   result: AutoResumeResult = { resumed: [], skipped: 0, failed: 0 }

  if (!config.autoResume) {return { resumed: [], skipped: candidates.length, failed: 0 }}

  const named = await scanNamedWorkflows({
    workflowPaths: config.workflowPaths,
    directory: options.directory ?? host.location.directory,
    onNote: (note) => options.onNote?.(note),
  })

  const ordered = [...candidates].toSorted((left, right) => left.startedAt - right.startedAt)
  for (const candidate of ordered) {
    try {
      const outcome = await adopt(candidate)
      if (outcome === "resumed") {result.resumed.push(candidate.runId)}
      else if (outcome === "skipped") {result.skipped++}
      else {result.failed++}
    } catch {
      // An unexpected failure must never break the boot sweep: count it and move on.
      result.failed++
    }
  }
  return result

  /** The per-run decision: adopt it, skip it, or fail to adopt it. */
  async function adopt(candidate: Manifest): Promise<"resumed" | "skipped" | "failed"> {
    const runId = candidate.runId,
     dir = runDir(runId, env),
     renameBack = async (): Promise<void> => {
       try {await rename(join(dir, CLAIM_MARKER), join(dir, INTERRUPTED_MARKER))} catch {
         // Best-effort: the run stays orphaned whether or not the hint is restored.
       }
     }

    // The pid veto, re-checked: a stale candidate list cannot execute a journal another process
    // may be writing.
    if (Number.isInteger(candidate.pid) && alive(candidate.pid)) {return "skipped"}

    const interruptedAt = candidate.endedAt ?? candidate.startedAt
    if (typeof interruptedAt === "number" && now - interruptedAt > ttlMs) {return "skipped"}

    // Project ownership (#175) and the `#149` #7 resolvability gate, checked BEFORE the claim so
    // a refused run keeps its hint marker and stays manually resumable.
    const session = await host.getSession(candidate.sessionID).catch(() => undefined)
    if (session === undefined) {return "skipped"}
    const recordedProject = candidate.projectID ?? session.projectID
    if (recordedProject !== host.location.projectID) {
      // V2 mints a project id from the directory string, so one checkout reached through an
      // alias (`/var/...` vs `/private/var/...`, or a symlinked worktree) yields two ids. The
      // recorded directory resolving to this host's canonical root is the same project; a
      // genuinely different directory is still refused.
      const canonicalRoot = host.location.canonical.trim() === "" ? host.location.directory : host.location.canonical
      const [recorded, canonical] = await Promise.all([physicalPath(candidate.directory), physicalPath(canonicalRoot)])
      if (recorded === undefined || canonical === undefined || recorded !== canonical) {return "skipped"}
    }
    // The parent agent must still resolve, or adoption fails closed (#149 #7). V2's permission
    // chain falls back to the host's default primary agent when the session row names none
    // (`session.agent` is optional); auto-resume resolves the agent through the SAME lookup the
    // chain uses, or every run launched from a plain `opencode run` session stays orphaned while
    // its journal is perfectly replayable.
    const lookup = createAncestorLookup(host),
     agentID = session.agent ?? (await lookup.defaultAgentID(host.location.directory))
    if (agentID === undefined || (await lookup.getAgent(agentID, host.location.directory)) === undefined) {
      return "skipped"
    }

    // The claim: renaming the marker is atomic, so two boots racing resolve to one winner and one
    // clean skip. ENOENT is the raced shape; anything else is this attempt genuinely failing.
    try {
      await rename(join(dir, INTERRUPTED_MARKER), join(dir, CLAIM_MARKER))
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {return "skipped"}
      return "failed"
    }

    const journal = await readJournal(runId, env)
    if (journal.some((entry) => isStopAbortDetail(entry.detail))) {
      await renameBack()
      return "skipped"
    }

    const transport = inspectArgsTransport(candidate.args),
     sweepArgs = transport.action === "hydrate" ? transport.value : candidate.args
    const resume = await loadResume(runId, sweepArgs, candidate.sessionID, env)
    if (resume.argsChanged) {
      await renameBack()
      return "skipped"
    }

    if (result.resumed.length >= config.autoResumeMax) {
      await renameBack()
      return "skipped"
    }

    let prepared: PreparedWorkflow
    try {
      prepared = await prepare(
        { script: await readFile(join(dir, "script.js"), "utf8"), args: sweepArgs },
        { host, project, coordinator, sessionID: candidate.sessionID, runId },
      )
    } catch {
      await renameBack()
      return "skipped"
    }

    // Re-stamp BEFORE executing, so a second restart during the resume re-orphans this run. The
    // original runId and project scope are kept; the fresh child list starts empty.
    const { endedAt: _dropped, ...rebase } = candidate,
     adopted: Manifest = {
       ...rebase,
       status: "running",
       bootId: coordinator.processBootId,
       pid: process.pid,
       childSessionIDs: [],
     }
    try {
      await writeManifest(runId, adopted, env)
    } catch {
      await renameBack()
      return "failed"
    }
    try {await rm(join(dir, CLAIM_MARKER), { force: true })} catch {
      // The claim token is disposable: a failed cleanup leaves a live run, not a wrong one.
    }

    options.onNote?.(`ultraopen: resuming ${runId} — interrupted when opencode exited`)

    // The native chain above the run's parent, rebuilt from the live session row: the resumed
    // run's children must record the SAME ancestry a fresh launch would, or the permission walk
    // cannot rebuild the chain after the restart.
    const ancestorSessionIDs = await nativeAncestorSessionIDs(host, candidate.sessionID)

    registerPending(coordinator, {
      runId,
      sessionID: candidate.sessionID,
      projectKey: project.projectKey,
      locationDir: host.location.directory,
    })
    nameRun(coordinator, runId, prepared.meta.name, candidate.title)
    startDetachedRun({
      runId,
      host,
      project,
      coordinator,
      worktreeRoot: host.location.canonical,
      sessionID: candidate.sessionID,
      ancestorSessionIDs,
      manifest: adopted,
      prepared,
      args: { script: prepared.source, args: sweepArgs },
      options: config,
      previousEntries: resume.entries,
      resumedFrom: runId,
      resume: { resumed: resume.entries.length, argsChanged: false },
      named: Object.keys(named).length > 0 ? named : undefined,
      env,
      executeFn: options.executeFn,
      explain: (replayed: number) =>
        `${runId} was interrupted when opencode exited; it has been resumed — ${replayed} agent(s) replayed from the journal`,
    })
    return "resumed"
  }
}
