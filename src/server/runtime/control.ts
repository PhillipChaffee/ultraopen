/**
 * The run-control channel: commands flow TUI → server through the run directory.
 *
 * One control file per run: `<runDir>/control.jsonl`, one JSON command per line
 * — the same file pattern as the journal, parsed with the same tolerance. The
 * TUI writes commands; the server reads them on a tick, runs them in order, and
 * records a cursor so a consumed command never acts twice (a command consumed
 * but not acknowledged before a crash runs again, so every ACTION must be safe
 * to run twice — pause, resume and stop are; restart goes through the journal's
 * own idempotence).
 *
 * Scope: the file lives in ONE run's directory, so cross-run commands cannot
 * exist by construction; a command naming a foreign run id is still rejected.
 */

export type ControlAction = "pause" | "resume" | "stop-run" | "stop-agent" | "restart-agent"

export interface ControlCommand {
  seq: number
  action: ControlAction
  /** Agent index for the agent-scoped actions. */
  target?: number | undefined
  /** The run id the TUI believed it was addressing; rejected when it lies. */
  run?: string | undefined
}

export const CONTROL_FILE = "control.jsonl"

export function controlPath(runDir: string): string {
  return `${runDir}/${CONTROL_FILE}`
}

const ACTIONS: readonly ControlAction[] = ["pause", "resume", "stop-run", "stop-agent", "restart-agent"]

/**
 * Parses a control file's text into commands, in file order.
 *
 * One JSON command per line. Malformed lines, unknown actions, bad sequence
 * numbers, and non-object lines are IGNORED (never a crash) — the file is
 * user-adjacent input written by the TUI and editable by hand.
 */
export function parseControlCommands(text: string, runId: string): ControlCommand[] {
  const out: ControlCommand[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") {continue}
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed !== "object" || parsed === null) {continue}
      const seq = typeof parsed["seq"] === "number" && Number.isInteger(parsed["seq"]) && parsed["seq"] >= 1 ? parsed["seq"] : undefined
      const action = typeof parsed["action"] === "string" && (ACTIONS as readonly string[]).includes(parsed["action"]) ? (parsed["action"] as ControlAction) : undefined
      if (seq === undefined || action === undefined) {continue}
      // A foreign run id is rejected even though the file lives in one run's
      // directory: the guard costs one string compare and closes the lie.
      if (parsed["run"] !== undefined && parsed["run"] !== runId) {continue}
      const target = typeof parsed["target"] === "number" && Number.isInteger(parsed["target"]) && parsed["target"] >= 0 ? parsed["target"] : undefined
      if ((action === "stop-agent" || action === "restart-agent") && target === undefined) {continue}
      out.push({ seq, action, ...(target === undefined ? {} : { target }), ...(parsed["run"] === undefined ? {} : { run: parsed["run"] as string }) })
    } catch {
      // Skip an unparseable line rather than failing the load.
    }
  }
  return out
}

/**
 * Applies the idempotence cursor: only commands ABOVE the highest processed
 * sequence are returned, in file order.
 */
export function pendingCommands(commands: readonly ControlCommand[], cursor: number): ControlCommand[] {
  return commands.filter((command) => command.seq > cursor)
}

/** The new cursor after processing: the highest consumed sequence, or the old one. */
export function nextCursor(commands: readonly ControlCommand[], cursor: number): number {
  return commands.reduce((highest, command) => Math.max(highest, command.seq), cursor)
}
export interface WatchOptions {
  runId: string
  runDir: string
  /** Dispatches one command to the run. */
  dispatch: (command: ControlCommand) => void
  /** Log sink for consumed commands and parse notes. */
  onNote?: ((note: string) => void) | undefined
  readFile?: ((path: string) => Promise<string>) | undefined
  writeFile?: ((path: string, body: string) => Promise<void>) | undefined
  intervalMs?: number | undefined
  /** Injectable timer bag for tests. */
  timers?: {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  } | undefined
}

/**
 * Watches one run's control file and dispatches pending commands.
 *
 * One read per tick; the cursor lives in MEMORY for the watcher's lifetime —
 * a crash between consume and acknowledge replays the command, and every
 * action is safe to run twice, so a cursor FILE would add I/O for no safety
 * the actions don't already guarantee. The watcher never rejects: every fallible
 * step swallows into a note.
 *
 * Returns the stop function; the tool layer clears it when the run settles.
 */
export function watchControl(options: WatchOptions): () => void {
  const readFile = options.readFile ?? ((path: string) => import("node:fs/promises").then((fs) => fs.readFile(path, "utf8"))),
   writeFile = options.writeFile ?? ((path: string, body: string) => import("node:fs/promises").then((fs) => fs.writeFile(path, body, "utf8"))),
   intervalMs = options.intervalMs ?? 1000
  let cursor = 0
  const timers = options.timers ?? {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as ReturnType<typeof setInterval>),
  }
  const handle: unknown = timers.setInterval(
    () => {
      void tick()
    },
    intervalMs,
  )


  const tick = async (): Promise<void> => {
    let text = ""
    try {
      text = await readFile(controlPath(options.runDir))
    } catch {
      return
    }
    const commands = pendingCommands(parseControlCommands(text, options.runId), cursor)
    if (commands.length === 0) {return}
    for (const command of commands) {
      options.dispatch(command)
      cursor = Math.max(cursor, command.seq)
      // The doc'd log sink: a consumed command is visible in the run's progress log, so a
      // pause or stop the TUI requested shows up where the user is looking.
      options.onNote?.(`run-control: ${command.action}${command.target === undefined ? "" : ` → agent ${command.target}`}`)
    }
    // The cursor is written back so a hand-edited replay is observable, but a
    // failed write changes nothing: the cursor is authoritative in memory.
    await writeFile(controlPath(options.runDir), `${text.trimEnd()}\n`).catch(() => undefined)
  }

  void tick()
  return () => {
    timers.clearInterval(handle)
  }
}