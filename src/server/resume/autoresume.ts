import { readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import type { UltraopenOptions } from "../options.js"
import type { OpencodeClient } from "../types.js"
import { STOP_ABORT_REASON, nameRun, registerPending } from "../tool/background.js"
import { startDetachedRun } from "../tool/settlement.js"
import { prepare } from "../tool/workflow.js"
import type { PreparedWorkflow } from "../tool/workflow.js"
import { scanNamedWorkflows } from "../tool/named.js"
import type { Manifest } from "./journal.js"
import { loadResume } from "./persist.js"
import { defaultProcessAlive } from "./reaper.js"
import { readJournal, runDir, writeManifest } from "./store.js"

/**
 * Auto-resume-on-boot: re-execute the runs a process death interrupted.
 *
 * Claude Code's durability default for workflows is journal-replay-on-return; this is the
 * plugin-side equivalent at boot. The reaper has already stopped the orphaned children and
 * harvested the freshly-interrupted manifests; this sweep decides, run by run, whether the
 * interrupted work should continue on its own. The journal survives process death by
 * construction (incremental flush), so the resume replays every completed agent instantly and
 * re-runs only the missing tail — with the ORIGINAL run id, because journal continuity lives in
 * that run directory.
 *
 * Every decision is a policy guard, each testable:
 *   - the run's pid must be dead (the reaper's veto keeps a live concurrent process's run safe —
 *     re-checked here so the sweep never trusts a stale candidate list);
 *   - the interruption must be younger than `autoResumeTtlHours`;
 *   - the stored args must still hash to the manifest's `argsHash` (reusing loadResume's check —
 *     a hand-edited or pre-feature manifest is skipped, never replayed against guessed inputs);
 *   - the original session must still exist (opencode sessions persist across restarts, so this
 *     fails only when the session was truly deleted);
 *   - stopped runs never resume: a child that recorded "stopped by request" (see #10's stop
 *     path) keeps the run permanently off the resume path;
 *   - at most `autoResumeMax` runs adopt per boot, oldest interruption first.
 *
 * Adoption is claimed by RENAMING the reaper's `interrupted.txt` marker — an atomic same-
 * filesystem test-and-set — so two opencode processes booting at once cannot both execute one
 * journal. The manifest is then re-stamped (new bootId/pid, status `running`) BEFORE executing,
 * so a second restart during a resume re-orphans the run instead of double-adopting it.
 */

/** The reaper's hint marker; renaming it claims the run for adoption. */
const INTERRUPTED_MARKER = "interrupted.txt"

/** The claimed marker's name between the rename and the re-stamp. */
const CLAIM_MARKER = "resuming.txt"

/** Swallows a best-effort cleanup failure — adoption must never reject on cleanup. */
const ignore = (): undefined => undefined

export interface AutoResumeResult {
  /** Run ids that were adopted and re-executed. */
  resumed: string[]
  /** Candidates skipped by a guard (TTL, argsChanged, session, stop, cap, veto). */
  skipped: number
  /** Candidates whose adoption itself failed (re-stamp unwritable). */
  failed: number
}

export interface AutoResumeDeps {
  client: OpencodeClient
  bootId: string
  /** Freshly-orphaned manifests from this boot's reap, in reaper order. */
  candidates: readonly Manifest[]
  options: UltraopenOptions
  /** Project directory, for saved-workflow resolution of nested `workflow("name")` calls. */
  directory?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  /** Injectable for tests. */
  now?: number | undefined
  /** Injectable for tests. */
  isProcessAlive?: ((pid: number) => boolean) | undefined
  /** Injectable engine for tests, passed through to the detached task. */
  executeFn?: DetachedRunSpec["executeFn"] | undefined
  onNote?: ((note: string) => void) | undefined
}

type DetachedRunSpec = Parameters<typeof startDetachedRun>[0]

/**
 * Resumes interrupted runs within the policy guards. NEVER REJECTS — every per-run failure is
 * swallowed and counted, like the reaper's sweep it follows, so callers can fire-and-forget.
 */
export async function resumeInterruptedRuns(deps: AutoResumeDeps): Promise<AutoResumeResult> {
  const { client, bootId, candidates, options, env } = deps,
   alive = deps.isProcessAlive ?? defaultProcessAlive,
   now = deps.now ?? Date.now(),
   ttlMs = options.autoResumeTtlHours * 60 * 60 * 1000,
   result: AutoResumeResult = { resumed: [], skipped: 0, failed: 0 }

  // The opt-out is a guard like the rest, so tests can pin it against the sweep itself.
  if (!options.autoResume) {return { resumed: [], skipped: candidates.length, failed: 0 }}

  // Saved workflows resolve from disk once per sweep, exactly like the launch path resolves them
  // per call: a nested `workflow("name")` call in the resumed script needs the same map.
  // scanNamedWorkflows never rejects, so there is no catch here — a broken path degrades to
  // notes, the same way it does for a launch.
  const named = await scanNamedWorkflows({
    workflowPaths: options.workflowPaths,
    directory: deps.directory,
    onNote: (note) => deps.onNote?.(note),
  })

  // Oldest interruption first: when the boot cap binds, the longest-waiting work wins.
  const ordered = [...candidates].toSorted((a, b) => a.startedAt - b.startedAt)

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
       await rename(join(dir, CLAIM_MARKER), join(dir, INTERRUPTED_MARKER)).catch(ignore)
     }

    // The pid veto, re-checked: the candidates were filtered by the reaper, but this sweep runs
    // concurrently with every other process on the shared data root — a run whose owner booted
    // between the reaper's look and this one must not be adopted twice.
    if (Number.isInteger(candidate.pid) && alive(candidate.pid)) {return "skipped"}

    // The resume window: measured from the moment the run became a pending decision (the
    // reaper's orphan stamp), not from the run's start — a run interrupted long ago but only
    // discovered by this boot is still fresh enough to matter once.
    const interruptedAt = candidate.endedAt ?? candidate.startedAt
    if (typeof interruptedAt === "number" && now - interruptedAt > ttlMs) {return "skipped"}

    // The claim: renaming the marker is atomic, so two boots racing to adopt the same run
    // resolve to one winner and one clean skip. No marker means someone else already claimed it.
    try {
      await rename(join(dir, INTERRUPTED_MARKER), join(dir, CLAIM_MARKER))
    } catch {
      return "skipped"
    }

    // Stopped runs never resume: if any child recorded the stop path's abort reason, the user
    // asked for this work to end — the crash-mid-stop race (process died between the abort and
    // the cancelled write) must not resurrect it.
    const journal = await readJournal(runId, env)
    if (journal.some((entry) => entry.detail === STOP_ABORT_REASON)) {
      await renameBack()
      return "skipped"
    }

    // The args guard, via loadResume's own hash check — never bypassed: the stored args are
    // re-hashed against the manifest's argsHash, so a tampered manifest (or a pre-args manifest
    // whose args were defined) is skipped rather than replayed against guessed inputs.
    const resume = await loadResume(runId, candidate.args, candidate.sessionID, env)
    if (resume.argsChanged) {
      await renameBack()
      return "skipped"
    }

    // The original session must still exist: hydration and the run's own subagent parent both
    // target it. Sessions persist across restarts, so absence means the session was deleted.
    const row = await client.session.get({ path: { id: candidate.sessionID } }).catch(ignore)
    if (row?.data === undefined) {
      await renameBack()
      return "skipped"
    }

    // The boot cap: at most `autoResumeMax` runs adopt per boot. Candidates beyond the cap keep
    // their hint marker (restored above) and stay manually resumable.
    if (result.resumed.length >= options.autoResumeMax) {
      await renameBack()
      return "skipped"
    }

    // Parse from disk BEFORE re-stamping: a corrupt persisted script is a permanent failure no
    // amount of re-execution fixes, so the run keeps its orphaned record and its hint.
    let prepared: PreparedWorkflow
    try {
      prepared = await prepare(
        { script: await readFile(join(dir, "script.js"), "utf8"), args: candidate.args },
        { client, sessionID: candidate.sessionID, runId },
      )
    } catch {
      await renameBack()
      return "skipped"
    }

    // Re-stamp BEFORE executing, so a second restart during the resume re-orphans this run
    // instead of double-adopting it. The original runId is kept — journal continuity lives in
    // this run directory — and the fresh child list starts empty, rebuilt by the run itself.
    const { endedAt: _dropped, ...rebase } = candidate,
     adopted: Manifest = { ...rebase, status: "running", bootId, pid: process.pid, childSessionIDs: [] }
    try {
      await writeManifest(runId, adopted, env)
    } catch {
      await renameBack()
      return "failed"
    }
    // The claim token has served its purpose; the run is now live and the sidebar reads the
    // manifest, not the hint.
    await rm(join(dir, CLAIM_MARKER), { force: true }).catch(ignore)

    deps.onNote?.(`ultraopen: resuming ${runId} — interrupted when opencode exited`)

    registerPending(runId, candidate.sessionID)
    nameRun(runId, prepared.meta.name)
    startDetachedRun({
      runId,
      client,
      sessionID: candidate.sessionID,
      manifest: adopted,
      prepared,
      args: { script: prepared.source, args: candidate.args },
      options,
      previousEntries: resume.entries,
      resumedFrom: runId,
      resume: { resumed: resume.entries.length, argsChanged: false },
      named: Object.keys(named).length > 0 ? named : undefined,
      env,
      executeFn: deps.executeFn,
      explain: (replayed: number) =>
        `${runId} was interrupted when opencode exited; it has been resumed — ${replayed} agent(s) replayed from the journal`,
    })
    return "resumed"
  }
}