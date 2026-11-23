import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  MAX_SCAN_FILES,
  parseSavedWorkflows,
  projectWorkflowDir,
  scanNamedWorkflows,
  userWorkflowDir,
  workflowDirectories,
} from "../src/server/tool/named.js"
import { execute } from "../src/server/tool/workflow.js"
import type { HostPort, HostTurnResult } from "../src/server/host/port.js"
import { resolveOptions } from "../src/server/options.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { join } from "node:path"

/**
 * Saved workflows: the scanner maps file names to sources, validates them with
 * the same parse the engine runs, and never lets a broken file take anything
 * down. Most tests inject the filesystem; two use a real temp directory.
 */

const META = "export const meta = { name: 'x', description: 'x' }\n"

/**
 * Defensive guard (#137): THIS FILE persists nothing today — its execute calls run with dryRun
 * and no persistence wiring (beginRun lives only in the launch path), verified by pointing
 * XDG_DATA_HOME at a fresh scratch root during a full run of this file: zero files created. The
 * guard costs nothing and makes any FUTURE persistence wiring here safe. The seven wild
 * `sessionID: "parent"` manifests came from outside the repo (one-off manual probes against the
 * default root); the stray dirs were removed and the rule is: probe against a scratch XDG home.
 */
let scratchHome: string,
 savedDataHome: string | undefined

beforeAll(async () => {
  scratchHome = await mkdtemp(join(tmpdir(), "ultraopen-named-"))
  savedDataHome = process.env["XDG_DATA_HOME"]
  process.env["XDG_DATA_HOME"] = scratchHome
})

afterAll(async () => {
  if (savedDataHome === undefined) {delete process.env["XDG_DATA_HOME"]}
  else {process.env["XDG_DATA_HOME"] = savedDataHome}
  await rm(scratchHome, { recursive: true, force: true })
})

const fakeFs = (dirs: Record<string, Record<string, string>>) => ({
  readDir: (path: string): Promise<string[]> => {
    const entries = dirs[path]
    if (entries === undefined) {return Promise.reject(new Error(`ENOENT: ${path}`))}
    return Promise.resolve(Object.keys(entries))
  },
  readFile: (path: string): Promise<string> => {
    const dir = Object.entries(dirs).find(([root]) => path.startsWith(root))
    const body = dir?.[1][path.split("/").pop() ?? ""]
    if (body === undefined) {return Promise.reject(new Error(`ENOENT: ${path}`))}
    return Promise.resolve(body)
  },
})

describe("workflow directories", () => {
  test("the user directory sits under the opencode configuration directory", () => {
    expect(userWorkflowDir({ OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv)).toBe("/cfg/ultraopen/workflows")
    expect(userWorkflowDir({} as NodeJS.ProcessEnv)).toContain(".config/opencode")
  })

  test("the user directory follows OPENCODE_CONFIG_DIR > XDG_CONFIG_HOME/opencode > ~/.config/opencode", () => {
    // V2 resolves the config dir through XDG too; honoring only the legacy env var made a
    // saved workflow invisible on hosts that set just XDG_CONFIG_HOME.
    expect(userWorkflowDir({ XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe("/xdg/opencode/ultraopen/workflows")
    expect(
      userWorkflowDir({ OPENCODE_CONFIG_DIR: "/cfg", XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv),
    ).toBe("/cfg/ultraopen/workflows")
    expect(userWorkflowDir({ OPENCODE_CONFIG_DIR: "  ", XDG_CONFIG_HOME: "/xdg" } as NodeJS.ProcessEnv)).toBe(
      "/xdg/opencode/ultraopen/workflows",
    )
    expect(userWorkflowDir({ XDG_CONFIG_HOME: "" } as NodeJS.ProcessEnv)).toContain(".config/opencode")
  })

  test("the project directory only exists when a project is known", () => {
    expect(projectWorkflowDir(undefined)).toBeUndefined()
    expect(projectWorkflowDir("/proj")).toContain(".opencode/ultraopen/workflows")
  })

  test("relative custom paths resolve against the project; absolute ones stand alone", () => {
    const dirs = workflowDirectories({
      workflowPaths: ["workflows", "/shared/workflows"],
      directory: "/proj",
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
    })
    expect(dirs).toEqual(["/cfg/ultraopen/workflows", "/proj/workflows", "/shared/workflows", "/proj/.opencode/ultraopen/workflows"])
  })

  test("without a project, the user directory is the only default", () => {
    const dirs = workflowDirectories({ env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv })
    expect(dirs).toEqual(["/cfg/ultraopen/workflows"])
  })

  test("the canonical project is scanned before the worktree directory, which wins collisions", () => {
    // A workflow saved in the canonical checkout must still resolve for an agent running in a
    // worktree; the worktree's own copy is stronger (last), the canonical one is a fallback.
    const dirs = workflowDirectories({
      canonicalDirectory: "/canon",
      directory: "/wt",
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
    })
    expect(dirs).toEqual([
      "/cfg/ultraopen/workflows",
      "/canon/.opencode/ultraopen/workflows",
      "/wt/.opencode/ultraopen/workflows",
    ])
  })

  test("a canonical directory equal to the worktree directory is scanned once", () => {
    const dirs = workflowDirectories({
      canonicalDirectory: "/proj",
      directory: "/proj",
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
    })
    expect(dirs).toEqual(["/cfg/ultraopen/workflows", "/proj/.opencode/ultraopen/workflows"])
  })
})

describe("scanNamedWorkflows", () => {
  test("maps file names (minus one extension) to their sources", async () => {
    const { readDir, readFile } = fakeFs({
      "/cfg/ultraopen/workflows": {
        "deploy-check.js": `${META}return 1\n`,
        "audit.mjs": `${META}return 2\n`,
        "notes.txt": "not a workflow",
      },
    })
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
      readDir,
      readFile,
    })
    expect(Object.keys(named)).toEqual(["deploy-check", "audit"])
    expect(named["deploy-check"]).toContain("return 1")
  })

  test("the project wins over the user directory on a name collision", async () => {
    const source = (body: string) => `${META}return ${body}\n`
    const { readDir, readFile } = fakeFs({
      "/cfg/ultraopen/workflows": { "same.js": source("'user'") },
      "/proj/.opencode/ultraopen/workflows": { "same.js": source("'project'") },
    })
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
      directory: "/proj",
      readDir,
      readFile,
    })
    expect(named["same"]).toContain("'project'")
  })

  test("a workflow saved in the canonical project resolves from a worktree session", async () => {
    const source = (body: string) => `${META}return ${body}\n`
    const { readDir, readFile } = fakeFs({
      "/canon/.opencode/ultraopen/workflows": { "from-canon.js": source("'canonical'") },
      "/wt/.opencode/ultraopen/workflows": { "from-wt.js": source("'worktree'") },
    })
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
      canonicalDirectory: "/canon",
      directory: "/wt",
      readDir,
      readFile,
    })
    expect(Object.keys(named).toSorted()).toEqual(["from-canon", "from-wt"])
    expect(named["from-canon"]).toContain("canonical")
  })

  test("a broken file is skipped and named in a note, never a crash", async () => {
    const notes: string[] = []
    const { readDir, readFile } = fakeFs({
      "/cfg/ultraopen/workflows": {
        "broken.js": "const x: string[] = []\n",
        "no-meta.js": "return 1\n",
        "good.js": `${META}return 3\n`,
      },
    })
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
      readDir,
      readFile,
      onNote: (note) => notes.push(note),
    })
    expect(Object.keys(named)).toEqual(["good"])
    expect(notes.length).toBe(2)
    expect(notes[0]).toContain("broken.js")
  })

  test("a missing directory is skipped silently; the plugin load never sees a throw", async () => {
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/nowhere" } as NodeJS.ProcessEnv,
      readDir: () => Promise.reject(new Error("ENOENT")),
      readFile: () => Promise.reject(new Error("ENOENT")),
    })
    expect(named).toEqual({})
  })

  test("a large directory is capped, loudly", async () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < MAX_SCAN_FILES + 20; i++) {big[`wf${i}.js`] = `${META}return ${i}\n`}
    const notes: string[] = []
    const { readDir, readFile } = fakeFs({ "/cfg/ultraopen/workflows": big })
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
      readDir,
      readFile,
      onNote: (note) => notes.push(note),
    })
    expect(Object.keys(named).length).toBe(MAX_SCAN_FILES)
    expect(notes.join(" ")).toContain("capped")
  })

  test("a hidden or extensionless file is not a workflow", async () => {
    const { readDir, readFile } = fakeFs({
      "/cfg/ultraopen/workflows": { ".hidden.js": `${META}return 1\n`, "README": "y", "sub.js": `${META}return 1\n` },
    })
    // `.hidden.js` strips to `.hidden` — no separator, so it is a (strange) name;
    // `README` has no script extension and is ignored entirely.
    const named = await scanNamedWorkflows({
      env: { OPENCODE_CONFIG_DIR: "/cfg" } as NodeJS.ProcessEnv,
      readDir,
      readFile,
    })
    expect(named[".hidden"]).toBeDefined()
    expect(named["README"]).toBeUndefined()
  })
})

// A dry run never spawns: the host is a stub that only answers the recursion guard's session
// lookup, which is undefined for an ordinary parent session.
const makeHost = (): HostPort => ({
  location: { directory: "/work", canonical: "/work", projectID: "project-1" },
  defaultModel: () => Promise.resolve(undefined),
  listModels: () => Promise.resolve([]),
  getSession: () => Promise.resolve(undefined),
  getAgent: () => Promise.resolve(undefined),
  listAgents: () => Promise.resolve([]),
  listPendingPermissions: () => Promise.resolve([]),
  rejectPermission: () => Promise.resolve(),
  createChildSession: () => Promise.resolve({ ok: true, sessionID: "child" }),
  moveSession: () => Promise.resolve({ ok: true }),
  runTurn: () => Promise.resolve({ ok: true, turn: { outcome: "succeeded", text: "ok", outputTokens: 0 } satisfies HostTurnResult }),
  interruptSession: () => Promise.resolve(true),
  admitSynthetic: () => Promise.resolve("admitted"),
})

describe("named resolution through the engine", () => {
  let coordinator: RuntimeCoordinator,
   project: ProjectRuntime
  beforeEach(() => {
    resetCoordinatorForTests()
    coordinator = getCoordinator()
    project = coordinator.projectOf(
      { directory: "/work", project: { id: "project-1", canonical: "/work" } },
      resolveOptions({}),
    )
  })

  test("the named form runs the saved source and never throws when the name exists", async () => {
    const result = await execute(
      { script: `${META}return await workflow('saved-probe')\n`, dryRun: true },
      {
        host: makeHost(),
        project,
        coordinator,
        sessionID: "p",
        runId: "wf_named0001",
        named: { "saved-probe": `${META}return 'from saved'\n` },
      },
    )
    expect(result.value).toBe("from saved")
  })

  test("an unknown name gives a clear error suggesting the inline form", async () => {
    await expect(
      execute(
        { script: `${META}return await workflow('nope')\n`, dryRun: true },
        { host: makeHost(), project, coordinator, sessionID: "p", runId: "wf_named0002" },
      ),
    ).rejects.toThrow(/No saved workflow named/u)
  })

  test("a name with a path separator is rejected, never used as a path", async () => {
    await expect(
      execute(
        { script: `${META}return await workflow('../../etc/passwd')\n`, dryRun: true },
        { host: makeHost(), project, coordinator, sessionID: "p", runId: "wf_named0003" },
      ),
    ).rejects.toThrow(/cannot contain a path separator/u)
  })
})

describe("parseSavedWorkflows — the synchronous command surface", () => {
  test("parses every scanned source into an entry with its meta description and source", () => {
    const entries = parseSavedWorkflows({
      "deploy-check": "export const meta = { name: 'deploy-check', description: 'Deploy gate' }\nreturn 1\n",
      bare: `${META}return 2\n`,
    })
    expect(entries).toEqual([
      {
        name: "deploy-check",
        description: "Deploy gate",
        source: "export const meta = { name: 'deploy-check', description: 'Deploy gate' }\nreturn 1\n",
      },
      { name: "bare", description: "x", source: `${META}return 2\n` },
    ])
  })

  test("a source that no longer parses loses its command instead of throwing", () => {
    expect(parseSavedWorkflows({ broken: "const x: string[] = []\n" })).toEqual([])
  })

  test("an empty scan is an empty command surface", () => {
    expect(parseSavedWorkflows({})).toEqual([])
  })
})
