import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendJournal,
  appendJournalEntry,
  artifactPaths,
  dataRoot,
  ensureRunDir,
  findOrphans,
  flushJournalEntry,
  isSafeRunId,
  readJournal,
  readManifest,
  runDir,
  writeManifest,
  writeResult,
  writeScript,
} from "../src/server/resume/store.js"
import type { JournalEntry, Manifest } from "../src/server/resume/journal.js"

const entry = (key: string): JournalEntry =>
  ({ type: "result", key, scopePath: "root", ordinal: 0, label: "l", outputTokens: 0, status: "ok" }) as JournalEntry

let base: string,
 env: NodeJS.ProcessEnv

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  runId: "wf_abc123",
  bootId: "boot-1",
  pid: 1,
  sessionID: "ses_1",
  sourceHash: "s",
  argsHash: "a",
  status: "running",
  childSessionIDs: [],
  startedAt: 0,
  ...overrides,
})

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "ultraopen-store-"))
  env = { XDG_DATA_HOME: base } as NodeJS.ProcessEnv
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe("paths", () => {
  test("artifacts live under opencode's already-whitelisted tool-output directory", () => {
    // That parent is appended to every agent's read allowlist AFTER user config, so the model can
    // read the journal with no permission prompt and without this plugin writing any config.
    expect(dataRoot(env)).toBe(join(base, "opencode", "tool-output", "ultraopen"))
  })

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset or blank", () => {
    expect(dataRoot({} as NodeJS.ProcessEnv)).toContain(join(".local", "share", "opencode"))
    expect(dataRoot({ XDG_DATA_HOME: "  " } as NodeJS.ProcessEnv)).toContain(join(".local", "share"))
  })

  test("no path component begins with tool_", () => {
    // opencode's own cleanup filters on that prefix and then parses the rest as a timestamp, so a
    // non-conforming tool_* name would make it throw and abort cleanup for the whole machine.
    for (const segment of runDir("wf_abc123", env).split("/")) {
      expect(segment.startsWith("tool_")).toBe(false)
    }
  })

  test("names the four artifacts inside the run directory", () => {
    const paths = artifactPaths("wf_abc123", env)
    expect(paths.journalPath).toBe(join(paths.dir, "journal.jsonl"))
    expect(paths.manifestPath).toBe(join(paths.dir, "manifest.json"))
    expect(paths.resultPath).toBe(join(paths.dir, "result.json"))
    expect(paths.scriptPath).toBe(join(paths.dir, "script.js"))
  })
})

describe("run id safety", () => {
  test.each(["wf_abc123", "wf_0123456789ab"])("accepts %s", (id) => {
    expect(isSafeRunId(id)).toBe(true)
  })

  test.each([
    ["a traversal attempt", "wf_../../etc"],
    ["a slash", "wf_a/b"],
    ["a wrong prefix", "run_abc123"],
    ["too short", "wf_ab"],
    ["uppercase", "wf_ABCDEF"],
    ["empty", ""],
  ])("rejects %s", (_label, id) => {
    expect(isSafeRunId(id)).toBe(false)
  })

  test("ensureRunDir refuses an unsafe id rather than sanitising it", async () => {
    // Rejecting outright keeps a caller-supplied id from ever reaching a path join.
    await expect(ensureRunDir("wf_../escape", env)).rejects.toThrow(/unsafe run id/u)
  })
})

describe("artifacts", () => {
  test("creates the directory and round-trips a manifest", async () => {
    await ensureRunDir("wf_abc123", env)
    await writeManifest("wf_abc123", manifest(), env)
    const reread = await readManifest("wf_abc123", env)
    expect(reread?.runId).toBe("wf_abc123")
  })

  test("round-trips a journal", async () => {
    await ensureRunDir("wf_abc123", env)
    await appendJournal("wf_abc123", '{"type":"result","key":"k","status":"ok","outputTokens":0}', env)
    const entries = await readJournal("wf_abc123", env)
    expect(entries.length).toBe(1)
  })


  test("appendJournalEntry appends one line per entry, so a killed run keeps completed agents", async () => {
    await ensureRunDir("wf_abc123", env)
    await appendJournalEntry("wf_abc123", entry("k1"), env)
    await appendJournalEntry("wf_abc123", entry("k2"), env)
    const persisted = await readJournal("wf_abc123", env)
    expect(persisted.map((e) => e.key)).toEqual(["k1", "k2"])
  })

  test("appendJournalEntry output survives a full endRun rewrite and parses identically", async () => {
    await ensureRunDir("wf_abc123", env)
    const entries = [entry("k1"), entry("k2")]
    for (const e of entries) {await appendJournalEntry("wf_abc123", e, env)}
    // EndRun settles the file with a full rewrite; incremental lines and the rewrite
    // Must produce the same journal.
    await appendJournal("wf_abc123", entries.map((e) => JSON.stringify(e)).join("\n"), env)
    const persisted = await readJournal("wf_abc123", env)
    expect(persisted.map((e) => e.key)).toEqual(["k1", "k2"])
  })

test("flushJournalEntry never rejects — a disk failure must not lose a live run", async () => {
    // A data home that is a FILE makes every write under it fail.
    const blocker = await mkdtemp(join(tmpdir(), "ultraopen-blocker-"))
    const fileHome = join(blocker, "file")
    await writeFile(fileHome, "x", "utf8")
    await flushJournalEntry("wf_abc123", entry("k1"), { XDG_DATA_HOME: fileHome } as NodeJS.ProcessEnv)
    await rm(blocker, { recursive: true })
  })

  test("flushJournalEntry repairs a torn tail instead of gluing the next entry onto it", async () => {
    await ensureRunDir("wf_abc123", env)
    // Simulate a mid-write kill: a partial final line without its newline.
    await writeFile(artifactPaths("wf_abc123", env).journalPath, `${JSON.stringify(entry("k1"))}\n${JSON.stringify(entry("k2")).slice(0, 20)}`, "utf8")
    await flushJournalEntry("wf_abc123", entry("k3"), env)
    const reread = await readJournal("wf_abc123", env)
    const keys = reread.map((e) => e.key)
    // k2 is genuinely lost (torn), but k1 survived and k3 did not glue onto the torn line.
    expect(keys).toEqual(["k1", "k3"])
  })

  test("writes result and script, returning their paths", async () => {
    await ensureRunDir("wf_abc123", env)
    expect(await writeResult("wf_abc123", { a: 1 }, env)).toContain("result.json")
    expect(await writeScript("wf_abc123", "export const meta = {}", env)).toContain("script.js")
  })

  test("reading a missing manifest or journal degrades instead of throwing", async () => {
    expect(await readManifest("wf_missing1", env)).toBeUndefined()
    expect(await readJournal("wf_missing1", env)).toEqual([])
  })

  test("a corrupt manifest reads as absent", async () => {
    await ensureRunDir("wf_abc123", env)
    await writeFile(artifactPaths("wf_abc123", env).manifestPath, "{not json", "utf8")
    expect(await readManifest("wf_abc123", env)).toBeUndefined()
  })
})

describe("orphan detection", () => {
  test("finds runs left running by a DIFFERENT boot", async () => {
    // The parent server never cascades an abort to plain parentID children, so a process that died
    // mid-run leaves them alive and billing.
    await ensureRunDir("wf_dead001", env)
    await writeManifest("wf_dead001", manifest({ runId: "wf_dead001", bootId: "old-boot" }), env)

    const orphans = await findOrphans("current-boot", env)
    expect(orphans.map((orphan) => orphan.runId)).toEqual(["wf_dead001"])
  })

  test("ignores runs from the CURRENT boot, which are still live", async () => {
    await ensureRunDir("wf_live001", env)
    await writeManifest("wf_live001", manifest({ runId: "wf_live001", bootId: "current-boot" }), env)
    expect(await findOrphans("current-boot", env)).toEqual([])
  })

  test.each(["completed", "failed", "orphaned"] as const)("ignores a %s run", async (status) => {
    await ensureRunDir("wf_done001", env)
    await writeManifest("wf_done001", manifest({ runId: "wf_done001", bootId: "old", status }), env)
    expect(await findOrphans("current-boot", env)).toEqual([])
  })

  test("ignores directories that are not run ids, and manifests that will not parse", async () => {
    await mkdir(join(dataRoot(env), "not-a-run"), { recursive: true })
    await ensureRunDir("wf_nomani1", env)
    expect(await findOrphans("current-boot", env)).toEqual([])
  })

  test("returns nothing when the data root does not exist yet", async () => {
    expect(await findOrphans("boot", { XDG_DATA_HOME: join(base, "absent") } as NodeJS.ProcessEnv)).toEqual([])
  })
})
