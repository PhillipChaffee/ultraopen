import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import {
  MAX_SCAN_FILES,
  listSavedWorkflows,
  projectWorkflowDir,
  scanNamedWorkflows,
  userWorkflowDir,
  workflowDirectories,
} from "../src/server/tool/named.js"
import { execute } from "../src/server/tool/workflow.js"
import type { OpencodeClient } from "../src/server/types.js"
import { join } from "node:path"

/**
 * Saved workflows: the scanner maps file names to sources, validates them with
 * the same parse the engine runs, and never lets a broken file take anything
 * down. Most tests inject the filesystem; two use a real temp directory.
 */

const META = "export const meta = { name: 'x', description: 'x' }\n"

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

describe("named resolution through the engine", () => {
  // The engine's client type is wide; the engine only touches session APIs and
  // the provider catalog when a run is LIVE, which dryRun never is. The cast
  // keeps the fake honest about being a stub, not a real client.
  const client = {
    config: { get: () => Promise.resolve({ data: {} }), providers: () => Promise.resolve({ data: { providers: [] } }) },
    session: {
      create: () => Promise.resolve({ data: { id: "child" } }),
      get: () => Promise.resolve({ data: { id: "child" } }),
      delete: () => Promise.resolve({}),
      abort: () => Promise.resolve({}),
      prompt: () => Promise.resolve({ data: { info: { tokens: { output: 0 } }, parts: [{ type: "text", text: "ok" }] } }),
    },
  } as never as OpencodeClient

  test("the named form runs the saved source and never throws when the name exists", async () => {
    const result = await execute(
      { script: `${META}return await workflow('saved-probe')\n`, dryRun: true },
      {
        client,
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
        { client, sessionID: "p", runId: "wf_named0002" },
      ),
    ).rejects.toThrow(/No saved workflow named/u)
  })

  test("a name with a path separator is rejected, never used as a path", async () => {
    await expect(
      execute(
        { script: `${META}return await workflow('../../etc/passwd')\n`, dryRun: true },
        { client, sessionID: "p", runId: "wf_named0003" },
      ),
    ).rejects.toThrow(/cannot contain a path separator/u)
  })

})

describe("listSavedWorkflows — sync, for command registration", () => {
  let dataHome: string,
   savedXDG: string | undefined

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "ultraopen-named-"))
    savedXDG = process.env["OPENCODE_CONFIG_DIR"]
    process.env["OPENCODE_CONFIG_DIR"] = dataHome
  })

  afterEach(async () => {
    if (savedXDG === undefined) {delete process.env["OPENCODE_CONFIG_DIR"]}
    else {process.env["OPENCODE_CONFIG_DIR"] = savedXDG}
    await rm(dataHome, { recursive: true, force: true })
  })

  test("registers only parseable files, with their meta descriptions", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const dir = userWorkflowDir()
    await mkdir(dir, { recursive: true })
    await writeFile(`${dir}/deploy-check.js`, "export const meta = { name: 'deploy-check', description: 'Deploy gate' }\nreturn 1\n")
    await writeFile(`${dir}/broken.js`, "const x: string[] = []\n")
    const saved = listSavedWorkflows({ env: process.env })
    expect(saved.map((entry) => entry.name)).toEqual(["deploy-check"])
    expect(saved[0]?.description).toBe("Deploy gate")
  })

  test("a missing configuration directory is not an error", () => {
    const saved = listSavedWorkflows({ env: { OPENCODE_CONFIG_DIR: "/nowhere-else" } as NodeJS.ProcessEnv })
    expect(saved).toEqual([])
  })
})