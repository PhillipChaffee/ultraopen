import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createV2HostPort } from "../src/server/host/v2-adapter.js"
import { loadBundledSkill, registerTransforms } from "../src/server/host/v2-transforms.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import { STATUS_TOOL, STRUCTURED_OUTPUT_TOOL, WORKFLOW_TOOL } from "../src/server/bridge/permission.js"
import { resolveOptions } from "../src/server/options.js"
import type { SavedWorkflow, WorkflowCommandState } from "../src/server/tool/launch.js"
import { makeFakePlugin } from "./v2-fixtures.js"

beforeEach(() => {
  resetCoordinatorForTests()
})

function harness(saved: SavedWorkflow[] = []) {
  const fake = makeFakePlugin({
      agents: [
        { id: "build", name: "build", mode: "primary", hidden: false, permissions: [] },
        { id: "explore", name: "explore", mode: "subagent", hidden: false, permissions: [] },
      ],
    }),
    coordinator = getCoordinator(),
    host = createV2HostPort(fake.ctx),
    project = coordinator.projectOf(fake.location, resolveOptions(undefined)),
    commandState: WorkflowCommandState = { entries: saved, reload: () => {void fake.reloadCommands()} },
    skill = {
      id: "workflow-authoring",
      name: "workflow-authoring",
      description: "authoring reference",
      path: "/repo/skills/workflow-authoring/SKILL.md",
      content: "# Workflow authoring",
    }

  const register = (): Promise<void> =>
    registerTransforms(fake.ctx, {
      host,
      project,
      coordinator,
      options: resolveOptions(undefined),
      bootId: coordinator.processBootId,
      longLived: false,
      commandState,
      skill,
      assertPermission: () => Promise.resolve(),
    })

  return { fake, coordinator, project, commandState, skill, register }
}

const permissionTriple = (agent: { permissions: { action: string; resource: string; effect: string }[] }) =>
  agent.permissions.map((rule) => `${rule.action}:${rule.resource}:${rule.effect}`)

describe("agent transform", () => {
  test("upserts the ultracode primary agent without a system prompt", async () => {
    const { fake, register } = harness()
    await register()
    const ultracode = fake.agents.find((agent) => agent.id === "ultracode")
    expect(ultracode).toBeDefined()
    expect(ultracode?.mode).toBe("primary")
    expect(ultracode?.name).toBe("ultracode")
    // `system` replaces the provider base prompt; the plugin must leave it unset.
    expect(ultracode?.system).toBeUndefined()
    expect(permissionTriple(ultracode ?? { permissions: [] })).toContain(`${WORKFLOW_TOOL}:*:ask`)
    expect(permissionTriple(ultracode ?? { permissions: [] })).toContain(`${STATUS_TOOL}:*:allow`)
  })

  test("primary agents get workflow:ask and workflow_status:allow", async () => {
    const { fake, register } = harness()
    await register()
    const build = fake.agents.find((agent) => agent.id === "build")
    expect(permissionTriple(build ?? { permissions: [] })).toContain(`${WORKFLOW_TOOL}:*:ask`)
    expect(permissionTriple(build ?? { permissions: [] })).toContain(`${STATUS_TOOL}:*:allow`)
  })

  test("subagents get both workflow tools denied", async () => {
    const { fake, register } = harness()
    await register()
    const explore = fake.agents.find((agent) => agent.id === "explore")
    expect(permissionTriple(explore ?? { permissions: [] })).toContain(`${WORKFLOW_TOOL}:*:deny`)
    expect(permissionTriple(explore ?? { permissions: [] })).toContain(`${STATUS_TOOL}:*:deny`)
  })

  test("a user policy that already denies workflow is not softened back to ask", async () => {
    const fake = makeFakePlugin({
      agents: [
        {
          id: "build",
          name: "build",
          mode: "primary",
          hidden: false,
          permissions: [{ action: WORKFLOW_TOOL, resource: "*", effect: "deny" }],
        },
      ],
    })
    const coordinator = getCoordinator(),
      host = createV2HostPort(fake.ctx),
      project = coordinator.projectOf(fake.location, resolveOptions(undefined))
    await registerTransforms(fake.ctx, {
      host,
      project,
      coordinator,
      options: resolveOptions(undefined),
      bootId: coordinator.processBootId,
      longLived: false,
      commandState: { entries: [], reload: () => {} },
      skill: undefined,
      assertPermission: () => Promise.resolve(),
    })
    const build = fake.agents.find((agent) => agent.id === "build")
    expect(permissionTriple(build ?? { permissions: [] })).toContain(`${WORKFLOW_TOOL}:*:deny`)
    expect(permissionTriple(build ?? { permissions: [] })).not.toContain(`${WORKFLOW_TOOL}:*:ask`)
  })
})

describe("command transform", () => {
  test("registers /ultracode, /workflow-resume and one /workflow-<name>", async () => {
    const { fake, commandState, project, register } = harness([
      { name: "deploy-check", description: "Deploy gate", source: "export const meta = { name: 'deploy-check', description: 'Deploy gate' }" },
    ])
    await register()
    expect([...fake.commands.keys()]).toContain("ultracode")
    expect([...fake.commands.keys()]).toContain("workflow-resume")
    expect([...fake.commands.keys()]).toContain("workflow-deploy-check")
    expect(fake.commands.get("workflow-deploy-check")?.description).toBe("Deploy gate")

    const command = fake.commands.get("workflow-deploy-check")
    await command?.execute({ sessionID: "s1", prompt: { text: "with args" }, delivery: "steer" })
    expect(fake.prompts.at(-1)?.text).toContain("workflow('deploy-check')")

    // A rescan replaces the entries; reload rebuilds the command surface.
    commandState.entries = [{ name: "audit", description: "Audit", source: "x" }]
    await fake.reloadCommands()
    expect(fake.commands.has("workflow-audit")).toBe(true)
    expect(project.mode.isActive("s1")).toBe(false)
  })

  test("/ultracode toggles the project mode, and off disables it", async () => {
    const { fake, project, register } = harness()
    await register()
    const command = fake.commands.get("ultracode")
    await command?.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" })
    expect(project.mode.isActive("s1")).toBe(true)
    await command?.execute({ sessionID: "s1", prompt: { text: "OFF" }, delivery: "steer" })
    expect(project.mode.isActive("s1")).toBe(false)
    // The toggle itself prompts nothing; a non-empty payload is forwarded.
    await command?.execute({ sessionID: "s1", prompt: { text: "ultracode this task" }, delivery: "steer" })
    expect(fake.prompts.at(-1)?.text).toBe("ultracode this task")
  })

  test("/workflow-resume forwards the run id (or asks for one)", async () => {
    const { fake, register } = harness()
    await register()
    const command = fake.commands.get("workflow-resume")
    await command?.execute({ sessionID: "s1", prompt: { text: "wf_resume01" }, delivery: "steer" })
    expect(fake.prompts.at(-1)?.text).toContain("The run id is wf_resume01")
    await command?.execute({ sessionID: "s1", prompt: { text: "" }, delivery: "steer" })
    expect(fake.prompts.at(-1)?.text).toContain("ask which run to resume")
  })
})

describe("bundled skill loading", () => {
  test("a layout with no SKILL.md degrades to no skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ultraopen-no-skill-"))
    try {
      await expect(loadBundledSkill(undefined, dir)).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("skill and tool transforms", () => {
  test("publishes the bundled skill with a path ending in SKILL.md", async () => {
    const { fake, register } = harness()
    await register()
    const skill = fake.skills.get("workflow-authoring")
    expect(skill?.path.endsWith("SKILL.md")).toBe(true)
    expect(skill?.content).toContain("Workflow authoring")
  })

  test("registers workflow, workflow_status and StructuredOutput with codemode off", async () => {
    const { fake, register } = harness()
    await register()
    for (const name of [WORKFLOW_TOOL, STATUS_TOOL, STRUCTURED_OUTPUT_TOOL]) {
      expect(fake.tools.get(name)?.options?.codemode).toBe(false)
    }
    expect(fake.tools.get(WORKFLOW_TOOL)?.input["type"]).toBe("object")
    expect(fake.tools.get(STATUS_TOOL)?.input["required"]).toEqual(["runId"])
    expect(fake.tools.get(STRUCTURED_OUTPUT_TOOL)?.input["additionalProperties"]).toBe(true)
  })

  test("ULTRAOPEN_ACTIVE=1 skips registering the tools but still installs the agent transform", async () => {
    process.env["ULTRAOPEN_ACTIVE"] = "1"
    try {
      const { fake, register } = harness()
      await register()
      expect(fake.tools.size).toBe(0)
      expect(fake.agents.some((agent) => agent.id === "ultracode")).toBe(true)
    } finally {
      delete process.env["ULTRAOPEN_ACTIVE"]
    }
  })
})
