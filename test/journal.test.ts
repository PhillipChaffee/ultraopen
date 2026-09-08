import { describe, expect, test } from "bun:test"
import { Journal, parseJournal } from "../src/server/resume/journal.js"
import type { JournalEntry } from "../src/server/resume/journal.js"

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({
  type: "result",
  key: "k1",
  scopePath: "root",
  ordinal: 0,
  label: "worker",
  status: "ok",
  value: "v",
  outputTokens: 5,
  ...overrides,
})

describe("replay index", () => {
  test("indexes ok entries for lookup", () => {
    const journal = new Journal()
    journal.loadPrevious([entry()])
    expect(journal.replayableCount).toBe(1)
    expect(journal.lookup("k1", undefined)?.value).toBe("v")
  })

  test("NEVER indexes a failed entry", () => {
    // Replaying a recorded failure would make a resume look like it covered everything when it
    // recovered nothing.
    const journal = new Journal()
    journal.loadPrevious([entry({ status: "null", reason: "api-error" })])
    expect(journal.replayableCount).toBe(0)
    expect(journal.lookup("k1", undefined)).toBeUndefined()
  })

  test("a schema mismatch is not replayed", () => {
    // The key already covers the schema, but a hand-edited or older-format journal could otherwise
    // satisfy a changed schema with a stale value.
    const journal = new Journal()
    journal.loadPrevious([entry({ schemaHash: "A" })])
    expect(journal.lookup("k1", "B")).toBeUndefined()
    expect(journal.lookup("k1", "A")?.value).toBe("v")
  })

  test("an entry recorded WITHOUT a schema is not replayed for a schema'd call", () => {
    const journal = new Journal()
    journal.loadPrevious([entry()])
    expect(journal.lookup("k1", "A")).toBeUndefined()
  })

  test("an unknown key misses", () => {
    const journal = new Journal()
    journal.loadPrevious([entry()])
    expect(journal.lookup("nope", undefined)).toBeUndefined()
  })

  test("a later entry with the same key wins", () => {
    const journal = new Journal()
    journal.loadPrevious([entry({ value: "first" }), entry({ value: "second" })])
    expect(journal.lookup("k1", undefined)?.value).toBe("second")
  })
})

describe("recording and stats", () => {
  test("counts total, ok, failed and replayed", () => {
    const journal = new Journal()
    journal.record(entry())
    journal.record(entry({ key: "k2", status: "null", reason: "deadline" }))
    journal.record(entry({ key: "k3", replayed: true }))

    expect(journal.stats).toEqual({ total: 3, ok: 2, failed: 1, replayed: 1 })
  })

  test("serialises as newline-delimited JSON", () => {
    const journal = new Journal()
    journal.record(entry())
    journal.record(entry({ key: "k2" }))

    const lines = journal.serialize().split("\n")
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0] ?? "{}").key).toBe("k1")
  })

  test("an empty journal serialises to an empty string", () => {
    expect(new Journal().serialize()).toBe("")
  })
})

describe("parseJournal", () => {
  test("round-trips a serialised journal", () => {
    const journal = new Journal()
    journal.record(entry())
    journal.record(entry({ key: "k2", value: { nested: [1, 2] } }))

    const parsed = parseJournal(journal.serialize())
    expect(parsed.length).toBe(2)
    expect(parsed[1]?.value).toEqual({ nested: [1, 2] })
  })

  test("tolerates a truncated final line", () => {
    // An interrupted run leaves a partial line, and that file is the only way to recover the run —
    // failing the whole load would throw away everything before the truncation.
    const good = JSON.stringify(entry())
    expect(parseJournal(`${good}\n{"type":"result","key":"k2"`).length).toBe(1)
  })

  test("skips blank lines and unparseable content", () => {
    const serialized = JSON.stringify(entry())
    expect(parseJournal(`\n\nnot json\n${serialized}\n`).length).toBe(1)
  })

  test.each([
    ["wrong type", { type: "other", key: "k", status: "ok" }],
    ["missing key", { type: "result", status: "ok" }],
    ["bad status", { type: "result", key: "k", status: "maybe" }],
    ["not an object", "a string"],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(parseJournal(JSON.stringify(value))).toEqual([])
  })

  test("an empty input yields no entries", () => {
    expect(parseJournal("")).toEqual([])
  })
})

describe("empty-state behaviour", () => {
  test("a fresh journal reports zeroes without needing any entries", () => {
    const journal = new Journal()
    expect(journal.replayableCount).toBe(0)
    expect(journal.stats).toEqual({ total: 0, ok: 0, failed: 0, replayed: 0 })
    expect(journal.lookup("anything", undefined)).toBeUndefined()
  })

  test("loadPrevious with an empty list is a no-op", () => {
    const journal = new Journal()
    journal.loadPrevious([])
    expect(journal.replayableCount).toBe(0)
  })

  test("entries is the live record list", () => {
    const journal = new Journal()
    journal.record(entry())
    expect(journal.entries.length).toBe(1)
    expect(journal.entries[0]?.key).toBe("k1")
  })
})
