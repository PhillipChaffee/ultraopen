import { describe, expect, test } from "bun:test"
import {
  CONTROL_FILE,
  controlPath,
  nextCursor,
  parseControlCommands,
  pendingCommands,
  watchControl,
} from "../src/server/runtime/control.js"

const runId = "wf_ctrl0001"

describe("parseControlCommands", () => {
  test("parses one JSON command per line, in file order", () => {
    const text = [
      JSON.stringify({ seq: 1, action: "pause" }),
      JSON.stringify({ seq: 2, action: "stop-agent", target: 3 }),
      JSON.stringify({ seq: 3, action: "resume" }),
    ].join("\n")
    const commands = parseControlCommands(text, runId)
    expect(commands.map((command) => command.seq)).toEqual([1, 2, 3])
    expect(commands[1]?.action).toBe("stop-agent")
    expect(commands[1]?.target).toBe(3)
  })

  test("malformed lines, unknown actions, and non-objects are ignored, never a crash", () => {
    const text = [
      "not json at all",
      JSON.stringify({ seq: 0, action: "pause" }),
      JSON.stringify({ seq: 1, action: "explode" }),
      JSON.stringify({ seq: 2, action: "stop-agent" }),
      JSON.stringify({ seq: 3, action: "pause" }),
      "",
    ].join("\n")
    const commands = parseControlCommands(text, runId)
    expect(commands).toEqual([{ seq: 3, action: "pause" }])
  })

  test("a command naming a foreign run id is rejected", () => {
    const text = JSON.stringify({ seq: 1, action: "pause", run: "wf_other001" })
    expect(parseControlCommands(text, runId)).toEqual([])
    const own = JSON.stringify({ seq: 1, action: "pause", run: runId })
    expect(parseControlCommands(own, runId).length).toBe(1)
  })

  test("agent-scoped actions require a non-negative integer target", () => {
    for (const target of [-1, 1.5, "2", true]) {
      const line = JSON.stringify({ seq: 1, action: "stop-agent", target })
      expect(parseControlCommands(line, runId)).toEqual([])
    }
  })
})

describe("cursor and idempotence", () => {
  test("pendingCommands skips sequences at or below the cursor", () => {
    const commands = parseControlCommands(
      [JSON.stringify({ seq: 1, action: "pause" }), JSON.stringify({ seq: 2, action: "resume" })].join("\n"),
      runId,
    )
    expect(pendingCommands(commands, 1)).toEqual([{ seq: 2, action: "resume" }])
    expect(pendingCommands(commands, 2)).toEqual([])
  })

  test("nextCursor takes the highest consumed sequence", () => {
    expect(nextCursor([], 3)).toBe(3)
    expect(nextCursor([{ seq: 5, action: "pause" }, { seq: 9, action: "resume" }], 1)).toBe(9)
  })
})

describe("watchControl", () => {
  let ticks = 0
  const tickTimers = () => {
    const callbacks: (() => void)[] = []
    return {
      timers: {
        setInterval: (fn: () => void): unknown => {
          callbacks.push(fn)
          return callbacks.length
        },
        clearInterval: (handle: unknown): void => {
          callbacks.splice(Number(handle) - 1, 1)
        },
      },
      tick: (): Promise<void> => {
        ticks++
        const fn = callbacks.at(-1)
        return fn === undefined ? Promise.resolve() : Promise.resolve(fn())
      },
      count: (): number => callbacks.length,
    }
  }

  test("dispatches pending commands in order and skips consumed sequences", async () => {
    let file = [
      JSON.stringify({ seq: 1, action: "pause" }),
      JSON.stringify({ seq: 2, action: "resume" }),
    ].join("\n")
    const bag = tickTimers(),
     dispatched: string[] = []
    const stop = watchControl({
      runId,
      runDir: "/runs/wf_ctrl0001",
      dispatch: (command) => dispatched.push(`${command.seq}:${command.action}`),
      readFile: () => Promise.resolve(file),
      writeFile: (_, body: string) => {
        file = body
        return Promise.resolve()
      },
      intervalMs: 10,
      timers: bag.timers,
    })
    await bag.tick()
    expect(dispatched).toEqual(["1:pause", "2:resume"])
    // The same file again dispatches nothing: the cursor consumed both.
    await bag.tick()
    expect(dispatched).toEqual(["1:pause", "2:resume"])
    // A new command above the cursor dispatches.
    file = `${file}\n${JSON.stringify({ seq: 3, action: "stop-run" })}`
    await bag.tick()
    expect(dispatched).toEqual(["1:pause", "2:resume", "3:stop-run"])
    stop()
    expect(bag.count()).toBe(0)
  })

  test("a missing or unreadable file is a silent no-op tick", async () => {
    const bag = tickTimers(),
     dispatched: string[] = []
    const stop = watchControl({
      runId,
      runDir: "/runs/wf_ctrl0001",
      dispatch: (command) => dispatched.push(command.action),
      readFile: () => Promise.reject(new Error("ENOENT")),
      intervalMs: 10,
      timers: bag.timers,
    })
    await bag.tick()
    expect(dispatched).toEqual([])
    stop()
  })

  test("the cursor stays in memory: a crash between consume and acknowledge replays a safe action", async () => {
    const bag = tickTimers(),
     dispatched: string[] = []
    const file = JSON.stringify({ seq: 1, action: "stop-run" })
    const stop = watchControl({
      runId,
      runDir: "/runs/wf_ctrl0001",
      dispatch: (command) => dispatched.push(command.action),
      readFile: () => Promise.resolve(file),
      intervalMs: 10,
      timers: bag.timers,
    })
    await bag.tick()
    stop()
    // A fresh watcher (as after a crash) starts from cursor 0 and replays:
    // stop-run is safe to run twice.
    const bag2 = tickTimers(),
     again: string[] = []
    const stop2 = watchControl({
      runId,
      runDir: "/runs/wf_ctrl0001",
      dispatch: (command) => again.push(command.action),
      readFile: () => Promise.resolve(file),
      intervalMs: 10,
      timers: bag2.timers,
    })
    await bag2.tick()
    expect(again).toEqual(["stop-run"])
    stop2()
  })

  test("the control file lives at one well-known path in the run directory", () => {
    expect(controlPath("/runs/wf_ctrl0001")).toBe(`/runs/wf_ctrl0001/${CONTROL_FILE}`)
    expect(CONTROL_FILE).toBe("control.jsonl")
  })
})