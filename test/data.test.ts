import { describe, expect, test } from "bun:test"
import { agentRowText, formatTokens, stopHint, writeControlCommand } from "../src/tui/data.js"
import type { RunView } from "../src/tui/data.js"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const runView = (runId: string): RunView => ({
  runId,
  workflow: "demo",
  sessionID: "ses_1",
  agents: [],
  done: 1,
  failed: 0,
  total: 1,
  elapsedSeconds: 5,
  logs: [],
})

describe("stopHint — the sidebar's stop guidance", () => {
  test("no live runs means no hint", () => {
    expect(stopHint([])).toBeUndefined()
  })

  test("a single live run names its id so the user can copy the call verbatim", () => {
    expect(stopHint([runView("wf_hint0001")])).toBe(
      `⏹ to stop a run: ask the agent for workflow({ stop: "wf_hint0001" }) — ESC does not stop it.`,
    )
  })

  test("several live runs keep the line generic instead of stacking ids", () => {
    const hint = stopHint([runView("wf_hint0001"), runView("wf_hint0002")])
    expect(hint).toContain('workflow({ stop: "<runId>" })')
    expect(hint).toContain("ESC does not stop it")
  })
})

describe("token counts in agent rows", () => {
  test("a settled agent's tokens render compactly", () => {
    expect(formatTokens(4321)).toBe("4.3k")
    expect(formatTokens(345)).toBe("345")
    expect(formatTokens(1_250_000)).toBe("1.3m")
    expect(agentRowText({ index: 0, label: "a", status: "done", outputTokens: 4321 })).toBe("✓ a · 4.3k")
    expect(agentRowText({ index: 0, label: "a", status: "running" })).toBe("⠋ a")
  })

  test("zero-token agents carry no token suffix", () => {
    expect(agentRowText({ index: 0, label: "a", status: "done", outputTokens: 0 })).toBe("✓ a")
  })
})

describe("writeControlCommand — the TUI's control-file writer", () => {
  test("appends one JSON line with the sequence and action", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ultraopen-ctrl-"))
    try {
      await writeControlCommand(dir, { action: "pause" }, 1)
      await writeControlCommand(dir, { action: "stop-agent", target: 2 }, 2)
      const text = await readFile(join(dir, "control.jsonl"), "utf8")
      const lines = text.trimEnd().split("\n")
      expect(JSON.parse(lines[0] ?? "{}")).toEqual({ seq: 1, action: "pause" })
      expect(JSON.parse(lines[1] ?? "{}")).toEqual({ seq: 2, action: "stop-agent", target: 2 })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})