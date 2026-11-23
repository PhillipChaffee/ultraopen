/**
 * The process-scoped runtime coordinator.
 *
 * opencode V2 re-runs a plugin's `setup()` on a same-PID reload, so anything the plugin owns must
 * outlive a module re-evaluation or the reload silently orphans live runs (#180). The coordinator
 * is therefore anchored on `globalThis`, and every piece of per-project state hangs off it:
 *
 * - one `processBootId` per OS process, so a same-PID reload is not mistaken for a crash;
 * - one `ProjectRuntime` per project (and per global-directory canonical path), each owning its
 *   own options, concurrency semaphore, ultracode mode, worktree queues and activations (#175);
 * - one live-run registry plus {@link RuntimeCoordinator.hostFor}, whose reloadable proxy routes
 *   every host call to the current activation, so an in-flight run keeps issuing host calls
 *   without interruption and without the registry having to know its host;
 * - child-session lineage, activity timestamps, event dedupe and pending child-shell tokens,
 *   all process-global because session and event ids are.
 */
import { createReloadableHost } from "../host/port.js"
import type { HostPort } from "../host/port.js"
import type { ProjectMode } from "../ultracode/mode.js"
import { createProjectMode } from "../ultracode/mode.js"
import type { UltraopenOptions } from "../options.js"
import { resolveOptions } from "../options.js"
import type { RpcRunView } from "../../rpc.js"
import { Semaphore } from "./semaphore.js"

/** Grace window between an activation's cleanup and an explicit-disable stop (spec §5.2). */
const DEFAULT_HANDOFF_GRACE_MS = 2000

/** Exactly how many event ids the dedupe FIFO remembers. Capacity is a contract, not a hint. */
const SEEN_EVENT_CAPACITY = 8192

/** The V2 location shape the coordinator keys projects on. */
export interface ProjectLocation {
  readonly directory: string
  readonly project: { readonly id: string; readonly canonical: string }
}

/** A child session this engine created, with the lineage and retry state its spawn needs. */
export interface ChildSessionRecord {
  readonly runId: string
  readonly projectKey: string
  readonly parentSessionID: string
  readonly ancestorSessionIDs: readonly string[]
  readonly index: number
  readonly label: string
  lastActivityAt: number
  contractText?: string | undefined
  schema?: Record<string, unknown> | undefined
  wrapped?: boolean | undefined
  disallowedTools?: readonly string[] | undefined
  currentAttempt: number
  captured?: { readonly value: unknown; readonly attempt: number } | undefined
  lastValidationErrors?: readonly string[] | undefined
}

/**
 * A live workflow run.
 *
 * There is deliberately no host reference: a run drives the {@link RuntimeCoordinator.hostFor}
 * proxy, which resolves the current activation's host at call time.
 */
export interface LiveRunRecord {
  readonly runId: string
  readonly sessionID: string
  readonly projectKey: string
  readonly locationDir: string
  status: "pending" | "running" | "stopping"
  readonly startedAt: number
  name?: string | undefined
  title?: string | undefined
  stopController?: AbortController | undefined
  settling?: Promise<void> | undefined
  /**
   * Marks this run's progress snapshot `stopping` through the run's OWN writer (#175).
   *
   * The stop path must trip the flag on the in-memory snapshot the engine keeps folding events
   * into; writing `progress.json` directly leaves that snapshot at `running`, so the next progress
   * event rewrites the file back and the stop visibly reverts. Absent for a run whose wiring has
   * not been assembled yet (a blocking launch before its first await) and for foreign records.
   */
  markStopping?: (() => Promise<void>) | undefined
  latestView?: RpcRunView | undefined
}

/** One shell call the tool hook authorized, waiting for its matching shell-creation hook. */
export interface PendingShellToken {
  readonly command: string
  readonly cwd?: string | undefined
  readonly expiresAt: number
}

/** One plugin activation: a `setup(ctx)` invocation at a specific directory. */
export interface LocationActivation {
  readonly generationId: number
  readonly hostPort: HostPort
  readonly abortController: AbortController
  readonly emitRunUpdated?: ((view: RpcRunView) => void) | undefined
  handoffTimer?: ReturnType<typeof setTimeout> | undefined
}

/** Everything one project owns, isolated from every other project in the process. */
export interface ProjectRuntime {
  readonly projectKey: string
  options: UltraopenOptions
  readonly semaphore: Semaphore
  readonly mode: ProjectMode
  readonly worktreeQueues: Map<string, Promise<void>>
  readonly activations: Map<string, LocationActivation>
  /**
   * The most recent registration per directory, retained when an activation is removed.
   *
   * A run's host proxy is a local `latest` variable refreshed on every resolution. After an idle
   * reload the proxy may never be called while the replacement activation is live; once that
   * activation is disabled the directory has no activation left, and without this record the proxy
   * would still point at the PRE-reload host. Keeping the last registration is what lets a stop
   * triggered by the disable itself reach the host that just went away.
   */
  readonly lastHostPorts: Map<string, HostPort>
  readonly pendingChildShells: PendingShellToken[]
}

/** Options for {@link RuntimeCoordinator.activateLocation}. */
export interface ActivateLocationOptions {
  /** This activation's resolved plugin options; applied to the project, never to a sibling. */
  readonly config?: UltraopenOptions | undefined
  readonly emitRunUpdated?: ((view: RpcRunView) => void) | undefined
}

/** Options for {@link RuntimeCoordinator.deactivateLocation}. */
export interface DeactivateLocationOptions {
  /** How long to wait for a replacement activation before treating cleanup as a disable. */
  readonly graceMs?: number | undefined
  /** Called for each of this exact `(projectKey, locationDir)`'s live runs once the grace expires. */
  readonly onDisableStop?: ((run: LiveRunRecord) => void) | undefined
}

export class RuntimeCoordinator {
  /** The one boot id of the OS process this coordinator lives in. */
  readonly processBootId: string
  readonly projects = new Map<string, ProjectRuntime>()
  /** Live runs across every project; single-valued because a run id is globally unique. */
  readonly runs = new Map<string, LiveRunRecord>()

  readonly #children = new Map<string, ChildSessionRecord>()
  readonly #seenEvents = new Set<string>()
  readonly #seenOrder: string[] = []
  #seenCursor = 0
  #generation = 0
  #bootSweep: Promise<unknown> | undefined
  /** Full per-project boot sweeps in flight, including `resumeInterruptedRuns`. */
  readonly #bootSweeps = new Set<Promise<unknown>>()
  readonly #settling = new Map<string, Promise<void>>()

  constructor() {
    this.processBootId = mintProcessBootId()
  }

  /** `project.id === "global" ? canonical : project.id` — global is a directory, not a project. */
  projectKeyOf(location: ProjectLocation): string {
    return location.project.id === "global" ? location.project.canonical : location.project.id
  }

  /**
   * The project's runtime, created on first sight.
   *
   * Later calls may refresh `options`: the new values are copied in and applied only to THIS
   * project's semaphore and mode, never to a sibling's.
   */
  projectOf(location: ProjectLocation, config?: UltraopenOptions): ProjectRuntime {
    const projectKey = this.projectKeyOf(location)
    const existing = this.projects.get(projectKey)
    if (existing === undefined) {
      const resolved = { ...(config ?? resolveOptions(undefined)) }
      const mode = createProjectMode()
      mode.setDefault(resolved.ultracode)
      mode.setKeywordBehavior(resolved.keywordBehavior)
      const created: ProjectRuntime = {
        projectKey,
        options: resolved,
        semaphore: new Semaphore(resolved.concurrency),
        mode,
        worktreeQueues: new Map<string, Promise<void>>(),
        activations: new Map<string, LocationActivation>(),
        lastHostPorts: new Map<string, HostPort>(),
        pendingChildShells: [],
      }
      this.projects.set(projectKey, created)
      return created
    }
    if (config !== undefined) {
      existing.options = { ...config }
      existing.semaphore.resize(config.concurrency)
      existing.mode.setDefault(config.ultracode)
      existing.mode.setKeywordBehavior(config.keywordBehavior)
    }
    return existing
  }

  /**
   * Starts one plugin activation at a directory.
   *
   * Any pending reload-handoff timer for that directory is cancelled: this IS the replacement the
   * handoff was waiting for. Runs owned by `(projectKey, locationDir)` need no adoption step — they
   * hold a {@link hostFor} proxy, whose next call resolves THIS activation's host.
   */
  activateLocation(
    location: ProjectLocation,
    hostPort: HostPort,
    activationOptions: ActivateLocationOptions = {},
  ): LocationActivation {
    const project = this.projectOf(location, activationOptions.config)
    const previous = project.activations.get(location.directory)
    if (previous?.handoffTimer !== undefined) {
      clearTimeout(previous.handoffTimer)
      previous.handoffTimer = undefined
    }

    const generationId = ++this.#generation
    const activation: LocationActivation = {
      generationId,
      hostPort,
      abortController: new AbortController(),
      ...(activationOptions.emitRunUpdated === undefined
        ? {}
        : { emitRunUpdated: activationOptions.emitRunUpdated }),
    }
    project.lastHostPorts.set(location.directory, hostPort)
    project.activations.set(location.directory, activation)
    return activation
  }

  /**
   * A stable host proxy for one `(projectKey, locationDir)`, for the lifetime of whatever holds it.
   *
   * Every call resolves against the CURRENT activation, so a same-PID reload hands in-flight runs
   * the replacement host without mutating a run record. After an explicit disable removes the
   * activation, the proxy keeps the last live host, so a stop triggered by the disable itself still
   * has a working port.
   */
  hostFor(projectKey: string, locationDir: string, fallback: HostPort): HostPort {
    let latest = fallback
    return createReloadableHost(() => {
      const project = this.projects.get(projectKey),
       current = project?.activations.get(locationDir)?.hostPort ?? project?.lastHostPorts.get(locationDir)
      if (current !== undefined) {latest = current}
      return latest
    })
  }

  /**
   * Ends one plugin activation.
   *
   * The generation's abort controller is aborted (its event subscription must stop at once). The
   * run-stop decision waits for a `.unref()` grace timer: a reload's replacement `setup()` usually
   * arrives inside the window and cancels the stop, while an explicit disable lets the timer fire.
   * A `.unref()` timer never keeps the process alive and never fires after the process exits, so a
   * crash leaves runs eligible for boot recovery instead of pretending they were stopped.
   *
   * A stale cleanup — a generation that is no longer the location's current one — does nothing: it
   * must not abort or clobber the newer activation.
   */
  deactivateLocation(
    projectKey: string,
    locationDir: string,
    generationId: number,
    deactivateOptions: DeactivateLocationOptions = {},
  ): void {
    const project = this.projects.get(projectKey)
    const activation = project?.activations.get(locationDir)
    if (project === undefined || activation === undefined) {return}
    if (activation.generationId !== generationId) {return}
    if (activation.handoffTimer !== undefined) {return}

    activation.abortController.abort()
    const graceMs = deactivateOptions.graceMs ?? DEFAULT_HANDOFF_GRACE_MS
    const timer = setTimeout(() => {
      activation.handoffTimer = undefined
      // The timer fired, so this process outlived the grace window: an explicit disable, not a
      // crash. Only the generation that armed this timer may act.
      if (project.activations.get(locationDir)?.generationId !== generationId) {return}
      project.activations.delete(locationDir)
      if (deactivateOptions.onDisableStop === undefined) {return}
      for (const run of this.runs.values()) {
        if (run.projectKey !== projectKey || run.locationDir !== locationDir) {continue}
        deactivateOptions.onDisableStop(run)
      }
    }, graceMs)
    timer.unref?.()
    activation.handoffTimer = timer
  }

  /**
   * Broadcasts one run's view to the live activations of its project.
   *
   * The live record is updated FIRST, so the process's own view of a run (what `listRuns`
   * answers for it) can never lag the event a TUI just received. A view for a run this process
   * does not hold — a sibling process's run, say — still broadcasts and simply has no record.
   */
  emitRunUpdated(projectKey: string, view: RpcRunView): void {
    const live = this.runs.get(view.runId)
    if (live !== undefined) {live.latestView = view}
    const project = this.projects.get(projectKey)
    if (project === undefined) {return}
    for (const activation of project.activations.values()) {activation.emitRunUpdated?.(view)}
  }

  registerChild(sessionID: string, record: ChildSessionRecord): void {
    this.#children.set(sessionID, record)
  }

  forgetChild(sessionID: string): void {
    this.#children.delete(sessionID)
  }

  /** Drops every child of a run when it settles. */
  forgetRunChildren(runId: string): void {
    for (const [sessionID, record] of this.#children) {
      if (record.runId === runId) {this.#children.delete(sessionID)}
    }
  }

  /** True when this engine created the session — the recursion guard's in-memory layer. */
  owns(sessionID: string): boolean {
    return this.#children.has(sessionID)
  }

  childOf(sessionID: string): ChildSessionRecord | undefined {
    return this.#children.get(sessionID)
  }

  /** Live children of a run, for abort fan-out and the runs reminder's agent count. */
  sessionsOf(runId: string): string[] {
    const sessions: string[] = []
    for (const [sessionID, record] of this.#children) {
      if (record.runId === runId) {sessions.push(sessionID)}
    }
    return sessions
  }

  /** Records observed progress for an owned child; a foreign session is ignored. */
  touchActivity(sessionID: string, at = Date.now()): void {
    const record = this.#children.get(sessionID)
    if (record !== undefined) {record.lastActivityAt = at}
  }

  /** Epoch ms of the child's last observed activity, 0 when unknown or never touched. */
  lastActivity(sessionID: string): number {
    return this.#children.get(sessionID)?.lastActivityAt ?? 0
  }

  /**
   * Claims one event id for processing. `true` the first time, `false` on a duplicate.
   *
   * O(1) membership over a bounded FIFO of exactly {@link SEEN_EVENT_CAPACITY} ids: once full, each
   * new id overwrites the oldest slot, so memory stays flat while a duplicate from the recent past
   * still reads as seen.
   */
  markEventSeen(eventId: string): boolean {
    if (this.#seenEvents.has(eventId)) {return false}
    this.#seenEvents.add(eventId)
    if (this.#seenOrder.length < SEEN_EVENT_CAPACITY) {
      this.#seenOrder.push(eventId)
      return true
    }
    const evicted = this.#seenOrder[this.#seenCursor]
    if (evicted !== undefined) {this.#seenEvents.delete(evicted)}
    this.#seenOrder[this.#seenCursor] = eventId
    this.#seenCursor = (this.#seenCursor + 1) % SEEN_EVENT_CAPACITY
    return true
  }

  /** Records a shell call the tool hook authorized, for the matching shell-creation hook. */
  pushPendingShell(projectKey: string, token: PendingShellToken): void {
    this.projects.get(projectKey)?.pendingChildShells.push(token)
  }

  /**
   * Consumes at most one matching token.
   *
   * A token matches on exact command plus, when the token names a cwd, the exact creation cwd. A
   * token without a cwd matches any directory. Expired tokens (`now > expiresAt`) are dropped on
   * sight and never match.
   */
  consumePendingShell(projectKey: string, command: string, cwd: string | undefined, now = Date.now()): boolean {
    const tokens = this.projects.get(projectKey)?.pendingChildShells
    if (tokens === undefined) {return false}
    let matchIndex = -1
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]
      if (token === undefined) {continue}
      if (now > token.expiresAt) {
        tokens.splice(index, 1)
        index--
        continue
      }
      if (matchIndex !== -1) {continue}
      if (token.command !== command) {continue}
      if (token.cwd !== undefined && token.cwd !== cwd) {continue}
      matchIndex = index
    }
    if (matchIndex === -1) {return false}
    tokens.splice(matchIndex, 1)
    return true
  }

  /**
   * Runs the once-per-boot global sweep and caches its RESULT on this coordinator.
   *
   * Every caller receives the same promise, so the first activation to ask starts the sweep while a
   * concurrent activation simply waits for it. The guard is keyed on `processBootId`: a same-PID
   * reload reuses the coordinator (and therefore the already-started sweep), while a new OS process
   * mints a new id and sweeps again.
   *
   * The result is cached, not just the promise: the sweep's orphan list is what every project's
   * resume sweep needs, including a project that boots AFTER the first one. Keeping it on the
   * coordinator is what makes it survive a same-PID module reload.
   */
  runBootSweepOnce<T>(sweep: () => Promise<T> | T): Promise<T> {
    this.#bootSweep ??= (async (): Promise<unknown> => await sweep())()
    return this.#bootSweep as Promise<T>
  }

  /** Resolves once EVERY boot sweep settle — the global sweep and each project's resume sweep. */
  async bootSweepSettled(): Promise<void> {
    // Looping, not a one-shot: a project's full sweep can be tracked while this call is waiting
    // (a second activation boots), and it too must finish before a hint poll reads the disk. The
    // fed promises are cached, so re-awaiting an already-settled one costs a microtask.
    for (;;) {
      if (this.#bootSweeps.size === 0 && this.#bootSweep === undefined) {return}
      const pending = this.#bootSweep === undefined
        ? [...this.#bootSweeps]
        : [this.#bootSweep, ...this.#bootSweeps]
      await Promise.all(pending.map((sweep) => sweep.then(() => undefined, () => undefined)))
      if (this.#bootSweeps.size === 0) {return}
    }
  }

  /**
   * Tracks one full boot sweep (global stages AND `resumeInterruptedRuns`) for
   * {@link bootSweepSettled}.
   *
   * Auto-resume claims `interrupted.txt` by renaming it, so a hint consumer that only waited for
   * the global reaper could unlink the marker first and turn a run that was about to resume into a
   * manual hint. Tracking the whole sweep is what orders those two readers.
   */
  trackBootSweep(sweep: Promise<void>): void {
    this.#bootSweeps.add(sweep)
    const cleanup = (): void => {
      this.#bootSweeps.delete(sweep)
    }
    void sweep.then(cleanup, cleanup)
  }

  /**
   * Records a detached run's settle promise on the coordinator.
   *
   * A settle can outlive the live record (the record is dropped in the task's `finally`), so the
   * map is the durable half: `settlingOf` answers after the record is gone. The entry is deleted
   * when the promise settles, only if it is still the current one.
   */
  trackSettling(runId: string, promise: Promise<void>): void {
    this.#settling.set(runId, promise)
    const live = this.runs.get(runId)
    if (live !== undefined) {live.settling = promise}
    const cleanup = (): void => {
      if (this.#settling.get(runId) === promise) {this.#settling.delete(runId)}
    }
    void promise.catch(() => undefined).finally(cleanup)
  }

  /** Resolves when the named run has fully settled; immediate when it never was tracked. */
  settlingOf(runId: string): Promise<void> {
    return this.#settling.get(runId) ?? this.runs.get(runId)?.settling ?? Promise.resolve()
  }
}

/**
 * The one boot id per OS process.
 *
 * Derived from the process's own facts — pid plus `performance.timeOrigin` — rather than a random
 * value: a same-PID plugin hot reload keeps both, so the replacement coordinator computes the SAME
 * id even if module state were ever rebuilt from scratch. That is the #180 fix: reload is not death.
 */
function mintProcessBootId(): string {
  return `${process.pid}-${Math.trunc(performance.timeOrigin)}`
}

const RUNTIME_SLOT = Symbol.for("ultraopen.v2.runtime")

type RuntimeGlobal = Record<symbol, RuntimeCoordinator | undefined>

/** The process-wide coordinator. Anchored on `globalThis`, so a same-PID reload ADOPTS it. */
export function getCoordinator(): RuntimeCoordinator {
  const host = globalThis as unknown as RuntimeGlobal
  const existing = host[RUNTIME_SLOT]
  if (existing !== undefined) {return existing}
  const coordinator = new RuntimeCoordinator()
  host[RUNTIME_SLOT] = coordinator
  return coordinator
}

/** Test-only: drop the anchored coordinator so the next call starts from a clean process view. */
export function resetCoordinatorForTests(): void {
  delete (globalThis as unknown as RuntimeGlobal)[RUNTIME_SLOT]
}
