import { beforeEach, describe, expect, test } from "bun:test"
import { createProjectMode, mentionsKeyword, requestsNoFanOut } from "../src/server/ultracode/mode.js"
import {
  decorate,
  decorateLatest,
  formatElapsed,
  messageIDOf,
  REMINDER_MARKER,
  renderRunsReminder,
  RUNS_REMINDER_PREFIX,
  ULTRACODE_DEMOTED,
  ULTRACODE_ON,
} from "../src/server/ultracode/reminders.js"
import type { LiveRunLine, RequestMessageLike } from "../src/server/ultracode/reminders.js"
import {
  onModelResolve,
  onSessionContext,
  onSessionPrompt,
  resolveUltracodeVariant,
} from "../src/server/ultracode/hooks.js"
import type { ModelResolveEventLike } from "../src/server/ultracode/hooks.js"
import { getCoordinator, resetCoordinatorForTests } from "../src/server/runtime/coordinator.js"
import type { ProjectRuntime, RuntimeCoordinator } from "../src/server/runtime/coordinator.js"
import { dropSettled, nameRun, registerPending } from "../src/server/tool/background.js"
import { resolveOptions } from "../src/server/options.js"

beforeEach(() => {
  resetCoordinatorForTests()
})

function projectOf(coordinator: RuntimeCoordinator): ProjectRuntime {
  return coordinator.projectOf(
    { directory: "/work", project: { id: "project-1", canonical: "/work" } },
    resolveOptions(undefined),
  )
}

const userMessage = (id: string, metadata = true): RequestMessageLike => ({
  role: "user",
  id,
  content: [{ type: "text", text: "hello" }],
  ...(metadata ? { metadata: { ultraopenMsgID: id } } : {}),
})

/** One live run as the reminder's renderer takes it — module scope, it captures nothing. */
const run = (runId: string, name: string, agents: number, startedAt: number): LiveRunLine => ({
  runId,
  name,
  agents,
  startedAt,
})

describe("keyword detection", () => {
  test.each([
    ["use ultracode for this", true],
    ["ULTRACODE please", true],
    ["ultracoded output", false],
    // A filename names a FILE, not a request to fan out.
    ["src/ultracode.ts", false],
    ["check pkg/ultracode/config.ts", false],
    ["Use ultracode.", true],
    ["nothing special", false],
  ])("%p -> %p", (text, expected) => {
    expect(mentionsKeyword(text)).toBe(expected)
  })
})

describe("no-fan-out detection", () => {
  test.each([
    ["don't use workflows", true],
    ["do not fan out", true],
    ["no subagents please", true],
    ["avoid workflows for this", true],
    // A negated mention must disable, never enable.
    ["don't use ultracode", true],
    ["use a workflow", false],
  ])("%p -> %p", (text, expected) => {
    expect(requestsNoFanOut(text)).toBe(expected)
  })
})

describe("project mode", () => {
  test("the ultracode AGENT needs no stored state", () => {
    const project = createProjectMode()
    expect(project.isActive("s1", "ultracode")).toBe(true)
    expect(project.isActive("s1", "build")).toBe(false)
  })

  test("an explicit toggle beats the ultracode agent itself", () => {
    const project = createProjectMode()
    project.disable("s1")
    expect(project.isActive("s1", "ultracode")).toBe(false)
  })

  test("markProcessedMessage is idempotent per session and message id", () => {
    const project = createProjectMode()
    expect(project.markProcessedMessage("s1", "msg_1")).toBe(true)
    expect(project.markProcessedMessage("s1", "msg_1")).toBe(false)
    expect(project.markProcessedMessage("s1", "msg_2")).toBe(true)
  })

  test("a project mode is independent of every other project", () => {
    const one = createProjectMode(),
     two = createProjectMode()
    one.enable("s1", "command")
    expect(one.isActive("s1")).toBe(true)
    expect(two.isActive("s1")).toBe(false)
  })

  test("reset clears every session, demotion and processed id", () => {
    const project = createProjectMode()
    project.setDefault(true)
    project.setKeywordBehavior("session")
    project.enable("s1", "keyword", "msg_1")
    project.demote("s1")
    project.markProcessedMessage("s1", "msg_1")
    project.reset()
    expect(project.stateOf("s1")).toBeUndefined()
    expect(project.isDemoted("s1")).toBe(false)
    expect(project.markProcessedMessage("s1", "msg_1")).toBe(true)
    expect(project.getKeywordBehavior()).toBe("one-shot")
    project.reset()
    expect(project.isActive("s1")).toBe(false)
  })
})

describe("reminder decoration", () => {
  test("decorates every user message from the toggle point onward", () => {
    const messages = [userMessage("m1"), userMessage("m2"), userMessage("m3")],
     decorated = decorate(messages, { text: ULTRACODE_ON, fromMessageID: "m2" })
    expect(decorated[0]?.content).toHaveLength(1)
    expect(decorated[1]?.content).toHaveLength(2)
    expect(decorated[2]?.content).toHaveLength(2)
  })

  test("decorates everything when no toggle point is given", () => {
    const messages = [userMessage("m1"), userMessage("m2")]
    expect(decorate(messages, { text: ULTRACODE_ON }).every((message) => message.content?.length === 2)).toBe(true)
  })

  test("is idempotent — the hook can fire more than once per turn", () => {
    const messages = [userMessage("m1")],
     once = decorate(messages, { text: ULTRACODE_ON }),
     twice = decorate(once, { text: ULTRACODE_ON })
    expect(twice[0]?.content).toHaveLength(2)
  })

  test("ignores assistant messages and a message id that never appears", () => {
    const messages: RequestMessageLike[] = [
      { role: "assistant", content: [] },
      userMessage("m1"),
    ]
    expect(decorate(messages, { text: ULTRACODE_ON, fromMessageID: "absent" })[1]?.content).toHaveLength(1)
  })

  test("messageIDOf prefers the stamped host id over the AI SDK id", () => {
    expect(messageIDOf({ id: "ai", metadata: { ultraopenMsgID: "msg_host" } })).toBe("msg_host")
    expect(messageIDOf({ id: "ai" })).toBe("ai")
    expect(messageIDOf({ metadata: { ultraopenMsgID: 42 } })).toBeUndefined()
  })

  test("decorateLatest appends once to the last user message and replaces on refire", () => {
    const messages = [userMessage("m1"), { role: "assistant", content: [] }, userMessage("m2")],
     once = decorateLatest(messages, `${RUNS_REMINDER_PREFIX}\nfirst`),
     twice = decorateLatest(once, `${RUNS_REMINDER_PREFIX}\nfresh`)
    expect(once[0]?.content).toHaveLength(1)
    expect(once[1]?.content).toHaveLength(0)
    expect(twice[2]?.content).toHaveLength(2)
    expect(String((twice[2]?.content?.[1] as { text?: string })?.text)).toContain("fresh")
  })
})

describe("onSessionPrompt", () => {
  test("the keyword turns the mode on and stamps the message id", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator),
     event: { sessionID: string; messageID: string; prompt: { text: string }; metadata?: Record<string, unknown> } = {
       sessionID: "s1",
       messageID: "msg_m1",
       prompt: { text: "please ultracode this audit" },
     }
    expect(onSessionPrompt(event, project, coordinator)).toBe(true)
    expect(project.mode.isActive("s1")).toBe(true)
    expect(project.mode.stateOf("s1")?.fromMessageID).toBe("msg_m1")
    expect(event.metadata).toEqual({ ultraopenMsgID: "msg_m1" })
  })

  test("is idempotent on the message id", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator),
     event = { sessionID: "s1", messageID: "msg_m1", prompt: { text: "ultracode this" } }
    expect(onSessionPrompt(event, project, coordinator)).toBe(true)
    project.mode.disable("s1")
    expect(onSessionPrompt(event, project, coordinator)).toBe(false)
    expect(project.mode.isActive("s1")).toBe(false)
  })

  test("records an instruction to stop fanning out", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    onSessionPrompt({ sessionID: "s1", messageID: "msg_1", prompt: { text: "ultracode but do not fan out" } }, project, coordinator)
    expect(project.mode.isDemoted("s1")).toBe(true)
  })

  test("one-shot: a new user turn expires the previous keyword turn", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    onSessionPrompt({ sessionID: "s1", messageID: "msg_1", prompt: { text: "ultracode this" } }, project, coordinator)
    onSessionPrompt({ sessionID: "s1", messageID: "msg_2", prompt: { text: "ordinary follow-up" } }, project, coordinator)
    expect(project.mode.isActive("s1")).toBe(false)
    expect(project.mode.stateOf("s1")).toBeUndefined()
  })

  test("engine-owned child sessions are never put into ultracode", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    coordinator.registerChild("child", {
      runId: "run-1",
      projectKey: project.projectKey,
      parentSessionID: "parent",
      ancestorSessionIDs: [],
      index: 0,
      label: "worker",
      lastActivityAt: Date.now(),
      currentAttempt: 0,
    })
    expect(onSessionPrompt({ sessionID: "child", messageID: "msg_1", prompt: { text: "ultracode this" } }, project, coordinator)).toBe(false)
    expect(project.mode.isActive("child")).toBe(false)
  })
})

describe("onSessionContext", () => {
  test("injects the ultracode reminder from the toggle point", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    project.mode.enable("s1", "keyword", "m2")
    const messages = [userMessage("m1"), userMessage("m2")],
     decorated = onSessionContext({ sessionID: "s1", agent: "build", messages }, project, coordinator),
     part = decorated[1]?.content?.at(-1) as { text?: string } | undefined
    expect(decorated[0]?.content).toHaveLength(1)
    expect(part?.text).toBe(ULTRACODE_ON)
    expect(part?.text).toContain(REMINDER_MARKER)
  })

  test("uses the demoted text when the user asked for no fan-out", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    project.mode.enable("s1", "keyword")
    project.mode.demote("s1")
    const messages = [userMessage("m1")],
     decorated = onSessionContext({ sessionID: "s1", agent: "build", messages }, project, coordinator)
    expect((decorated[0]?.content?.at(-1) as { text?: string })?.text).toBe(ULTRACODE_DEMOTED)
  })

  test("activates from the ultracode AGENT with no stored state", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    const messages = [userMessage("m1")]
    expect(onSessionContext({ sessionID: "s1", agent: "ultracode", messages }, project, coordinator)[0]?.content).toHaveLength(2)
  })

  test("appends the live-run reminder even with ultracode off", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    registerPending(coordinator, {
      runId: "wf_runs0001",
      sessionID: "s1",
      projectKey: project.projectKey,
      locationDir: "/work",
      name: "demo",
    }, 100)
    const messages = [userMessage("m1")],
     decorated = onSessionContext({ sessionID: "s1", agent: "build", messages }, project, coordinator, { now: () => 61_100 }),
     text = String((decorated[0]?.content?.at(-1) as { text?: string })?.text)
    expect(text).toContain('wf_runs0001 "demo"')
    expect(text).toContain("1m elapsed")
    expect(text.startsWith(RUNS_REMINDER_PREFIX)).toBe(true)
  })

  test("names the workflow once known, and shows the title as a parenthetical", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    registerPending(coordinator, {
      runId: "wf_runs0010",
      sessionID: "s1",
      projectKey: project.projectKey,
      locationDir: "/work",
    }, 100)
    nameRun(coordinator, "wf_runs0010", "audit-diff", "Fix the login bug")
    const messages = [userMessage("m1")]
    const text = String((onSessionContext({ sessionID: "s1", agent: "build", messages }, project, coordinator)[0]?.content?.at(-1) as { text?: string })?.text)
    expect(text).toContain('- wf_runs0010 "audit-diff" (Fix the login bug) —')
  })

  test("the reminder disappears once every live run has settled", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    registerPending(coordinator, {
      runId: "wf_runs0003",
      sessionID: "s1",
      projectKey: project.projectKey,
      locationDir: "/work",
    }, 100)
    expect(onSessionContext({ sessionID: "s1", agent: "build", messages: [userMessage("m1")] }, project, coordinator)[0]?.content).toHaveLength(2)
    dropSettled(coordinator, "wf_runs0003")
    expect(onSessionContext({ sessionID: "s1", agent: "build", messages: [userMessage("m1")] }, project, coordinator)[0]?.content).toHaveLength(1)
  })

  test("skips engine-owned sessions", () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator)
    coordinator.registerChild("child", {
      runId: "run-1",
      projectKey: project.projectKey,
      parentSessionID: "parent",
      ancestorSessionIDs: [],
      index: 0,
      label: "worker",
      lastActivityAt: Date.now(),
      currentAttempt: 0,
    })
    project.mode.enable("child", "keyword")
    const messages = [userMessage("m1")]
    expect(onSessionContext({ sessionID: "child", agent: "build", messages }, project, coordinator)[0]?.content).toHaveLength(1)
  })
})

describe("onModelResolve", () => {
  test("sets the variant for a single primary request without mutating the saved model", async () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator),
     saved: { providerID: string; id: string; variant?: string } = { providerID: "p", id: "m" },
     event: ModelResolveEventLike = { sessionID: "s1", agent: "build", kind: "primary", model: saved }
    project.mode.enable("s1", "keyword")
    expect(await onModelResolve(event, project, coordinator, () => "xhigh")).toBe(true)
    expect(event.model.variant).toBe("xhigh")
    expect(saved).not.toHaveProperty("variant")
  })

  test("does nothing for auxiliary requests, children, or an inactive mode", async () => {
    const coordinator = getCoordinator(),
     project = projectOf(coordinator),
     event = { sessionID: "s1", agent: "build", kind: "compaction", model: { providerID: "p", id: "m" } }
    expect(await onModelResolve(event, project, coordinator, () => "xhigh")).toBe(false)
    project.mode.enable("s1", "keyword")
    expect(await onModelResolve({ ...event, kind: "primary" }, project, coordinator, () => undefined)).toBe(false)
  })

  test("resolves xhigh through the model's real variants", () => {
    expect(resolveUltracodeVariant(["low", "high"])).toBe("high")
    expect(resolveUltracodeVariant(["xhigh", "max"])).toBe("xhigh")
    expect(resolveUltracodeVariant([])).toBeUndefined()
  })
})

describe("runs reminder shape and elapsed format", () => {
  test("the same state renders byte-identically", () => {
    const runs = [run("wf_shape001", "audit-diff", 3, 100)]
    expect(renderRunsReminder(runs, 62_100)).toBe(renderRunsReminder(runs, 62_100))
  })

  test("a title with a newline stays one line", () => {
    const rendered = renderRunsReminder([{ ...run("wf_shape006", "demo", 1, 100), title: "Fix\nthe bug" }], 62_100)
    expect(rendered.split("\n")).toHaveLength(6)
    expect(rendered).toContain('- wf_shape006 "demo" (Fix the bug) —')
  })

  test.each([
    [0, "0s"],
    [59_999, "59s"],
    [60_000, "1m"],
    [3_599_999, "59m"],
    [3_600_000, "1h00m"],
    [7_326_000, "2h02m"],
  ])("formatElapsed(%p) -> %p", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})
