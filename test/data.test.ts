import { describe, expect, test } from "bun:test"
import { agentRowText, formatTokens, writeControlCommand } from "../src/tui/data.js"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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