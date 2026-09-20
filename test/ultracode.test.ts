import { beforeEach, describe, expect, test } from "bun:test"
import { mentionsKeyword, mode, requestsNoFanOut } from "../src/server/ultracode/mode.js"
import {
  decorate,
  decorateLatest,
  formatElapsed,
  REMINDER_MARKER,
  renderRunsReminder,
  RUNS_REMINDER_PREFIX,
  ULTRACODE_DEMOTED,
  ULTRACODE_ON,
} from "../src/server/ultracode/reminders.js"
import type { LiveRunLine, MessageLike } from "../src/server/ultracode/reminders.js"
import { onChatMessage, onChatParams, onMessagesTransform } from "../src/server/ultracode/hooks.js"
import type { MessagesTransformOutput } from "../src/server/ultracode/hooks.js"
import { registry } from "../src/server/singleton.js"
import {
  dropSettled,
  nameRun,
  registerPending,
  resetForTests as resetRunsRegistry,
} from "../src/server/tool/background.js"

beforeEach(() => {
  mode.resetForTests()
  registry.resetForTests()
  resetRunsRegistry()
})

const userMessage = (id: string, sessionID = "s1", agent?: string): MessageLike => ({
  info: { id, role: "user", sessionID, ...(agent ? { agent } : {}) },
  parts: [],
})

/** One live run as the reminder's renderer takes it — module scope, it captures nothing. */
const run = (runId: string, name: string, agents: number, startedAt: number): LiveRunLine => ({
  runId,
  name,
  agents,
  startedAt,
})

/** The constant template lines of a rendered reminder: header, phrasing, closer. */
const templateOf = (lines: string[]) => [lines[0], lines[1], lines[2], lines[3], lines.at(-1)]

describe("keyword detection", () => {
  test.each([
    ["use ultracode for this", true],
    ["ULTRACODE please", true],
    ["let's ultracode it", true],
    ["ultracoded output", false],
    // A filename names a FILE, not a request to fan out: a stray mention raising
    // the spend of every later message was the review's top-ranked danger.
    ["src/ultracode.ts", false],
    ["ultracode.ts", false],
    ["check pkg/ultracode/config.ts", false],
    ["my.ultracode-backup", false],
    // Sentence punctuation stays a trigger: the filter must not eat real asks.
    ["Use ultracode.", true],
    ["Ultracode", true],
    ["do the audit with ultracode!", true],
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
    ["stop using parallel agents", true],
    ["avoid workflows for this", true],
    // A negated mention must disable, never enable — enabling here would invert the user's intent.
    ["don't use ultracode", true],
    ["stop using ultracode", true],
    ["use a workflow", false],
    ["run this in parallel", false],
  ])("%p -> %p", (text, expected) => {
    // Deliberately narrow: a false positive silently disables the feature the user turned on,
    // which is worse than missing a phrasing.
    expect(requestsNoFanOut(text)).toBe(expected)
  })
})

describe("mode state", () => {
  test("the ultracode AGENT needs no stored state", () => {
    expect(mode.isActive("s1", "ultracode")).toBe(true)
    expect(mode.isActive("s1", "build")).toBe(false)
  })

  test("an explicit toggle beats the ultracode AGENT itself", () => {
    // A user on the ultracode agent who runs /ultracode off must actually get the mode off —
    // the command is the later, more explicit instruction.
    mode.disable("s1")
    expect(mode.isActive("s1", "ultracode")).toBe(false)
  })

  test("enable and disable are per session", () => {
    mode.enable("s1", "command")
    expect(mode.isActive("s1")).toBe(true)
    expect(mode.isActive("s2")).toBe(false)
    mode.disable("s1")
    expect(mode.isActive("s1")).toBe(false)
  })

  test("the project default applies to sessions with no explicit toggle", () => {
    mode.setDefault(true)
    expect(mode.isActive("fresh")).toBe(true)
  })

  test("an explicit /ultracode off beats the project default", () => {
    mode.setDefault(true)
    mode.disable("s1")
    expect(mode.isActive("s1")).toBe(false)
    // And does not leak into other sessions.
    expect(mode.isActive("s2")).toBe(true)
  })

  test("demotion is recorded per session", () => {
    mode.demote("s1")
    expect(mode.isDemoted("s1")).toBe(true)
    expect(mode.isDemoted("s2")).toBe(false)
  })

  test("an explicit re-enable clears a demotion", () => {
    // The user saying "use ultracode again" is a later, more explicit instruction than the
    // earlier "don't fan out" — staying demoted would silently ignore the re-enable.
    mode.demote("s1")
    mode.enable("s1", "keyword")
    expect(mode.isDemoted("s1")).toBe(false)
  })
})

describe("reminder decoration", () => {
  test("decorates every user message from the toggle point onward", () => {
    // Not just the last: that is what makes a mid-conversation switch legible, and it keeps the
    // cache prefix byte-stable instead of moving every turn.
    const messages = [userMessage("m1"), userMessage("m2"), userMessage("m3")]
    expect(decorate(messages, { text: ULTRACODE_ON, fromMessageID: "m2" })).toBe(2)
    expect(messages[0]?.parts?.length).toBe(0)
    expect(messages[1]?.parts?.length).toBe(1)
    expect(messages[2]?.parts?.length).toBe(1)
  })

  test("decorates everything when no toggle point is given", () => {
    const messages = [userMessage("m1"), userMessage("m2")]
    expect(decorate(messages, { text: ULTRACODE_ON })).toBe(2)
  })

  test("is idempotent — the hook can fire more than once per turn", () => {
    const messages = [userMessage("m1")]
    decorate(messages, { text: ULTRACODE_ON })
    expect(decorate(messages, { text: ULTRACODE_ON })).toBe(0)
    expect(messages[0]?.parts?.length).toBe(1)
  })

  test("marks parts synthetic so they never reach the transcript", () => {
    const messages = [userMessage("m1")]
    decorate(messages, { text: ULTRACODE_ON })
    const part = messages[0]?.parts?.[0] as Record<string, unknown> | undefined
    expect(part?.["synthetic"]).toBe(true)
    expect(String(part?.["text"])).toContain(REMINDER_MARKER)
  })

  test("ignores assistant messages and malformed entries", () => {
    const messages: MessageLike[] = [
      { info: { id: "a1", role: "assistant", sessionID: "s1" }, parts: [] },
      { info: { id: "m1", role: "user", sessionID: "s1" } },
    ]
    expect(decorate(messages, { text: ULTRACODE_ON })).toBe(0)
  })

  test("a message id that never appears decorates nothing", () => {
    const messages = [userMessage("m1")]
    expect(decorate(messages, { text: ULTRACODE_ON, fromMessageID: "absent" })).toBe(0)
  })
})

const chatOutput = (text: string) => ({
  message: { id: "m1", model: { variant: undefined as string | undefined } },
  parts: [{ type: "text", text }],
})

describe("chat.message hook", () => {
  test("the keyword turns the mode on for that session", () => {
    const out = chatOutput("please ultracode this audit")
    onChatMessage({ sessionID: "s1" }, out)
    expect(mode.isActive("s1")).toBe(true)
  })

  test("raises the effort variant on the user message", () => {
    const out = chatOutput("ultracode this")
    onChatMessage({ sessionID: "s1" }, out, { resolveVariant: () => "xhigh" })
    expect(out.message.model.variant).toBe("xhigh")
  })

  test("does NOT write parts — those are persisted and would accumulate forever", () => {
    const out = chatOutput("ultracode this")
    onChatMessage({ sessionID: "s1" }, out)
    expect(out.parts.length).toBe(1)
  })

  test("records an instruction to stop fanning out", () => {
    onChatMessage({ sessionID: "s1" }, chatOutput("ultracode but do not fan out"))
    expect(mode.isDemoted("s1")).toBe(true)
  })

  test("a negated keyword mention demotes and does NOT enable", () => {
    // "don't use ultracode" must not switch the mode on — the keyword regex cannot see negation,
    // so the no-fan-out detector gates it.
    onChatMessage({ sessionID: "s1" }, chatOutput("don't use ultracode"))
    expect(mode.isActive("s1")).toBe(false)
    expect(mode.isDemoted("s1")).toBe(true)
  })

  test("one-shot: a new user turn expires the previous keyword turn", () => {
    // A keyword fans out exactly the task that said it. The NEXT user message
    // starts with the keyword state gone, so the plain follow-up behaves
    // normally — no reminder, no effort raise, no fan-out.
    const first = chatOutput("ultracode this")
    first.message.id = "m1"
    onChatMessage({ sessionID: "s1" }, first)
    expect(mode.isActive("s1")).toBe(true)

    const next = chatOutput("now something ordinary")
    next.message.id = "m2"
    onChatMessage({ sessionID: "s1" }, next)
    expect(mode.isActive("s1")).toBe(false)
    expect(mode.get("s1")).toBeUndefined()
  })

  test("one-shot: re-mentioning the keyword re-arms for the NEW task", () => {
    const first = chatOutput("ultracode this")
    first.message.id = "m1"
    onChatMessage({ sessionID: "s1" }, first)
    expect(mode.get("s1")?.fromMessageID).toBe("m1")

    const again = chatOutput("more ultracode please")
    again.message.id = "m2"
    onChatMessage({ sessionID: "s1" }, again)
    expect(mode.get("s1")?.fromMessageID).toBe("m2")
  })

  test("session behavior reproduces the old sticky semantics exactly", () => {
    // Characterization of the pre-one-shot behaviour: one mention keeps the mode
    // across later turns, and a re-mention never moves the reminder toggle.
    mode.setKeywordBehavior("session")
    const first = chatOutput("ultracode this")
    first.message.id = "m1"
    onChatMessage({ sessionID: "s1" }, first)
    expect(mode.get("s1")?.fromMessageID).toBe("m1")

    const again = chatOutput("more ultracode please")
    again.message.id = "m2"
    onChatMessage({ sessionID: "s1" }, again)
    expect(mode.get("s1")?.fromMessageID).toBe("m1")
    expect(mode.isActive("s1")).toBe(true)
  })

  test("mentioning the keyword while disabled by a command DOES re-enable", () => {
    // The source changed — a fresh keyword mention after /ultracode off is the user asking again.
    mode.disable("s1")
    onChatMessage({ sessionID: "s1" }, chatOutput("ultracode this"))
    expect(mode.isActive("s1")).toBe(true)
  })

  test("engine-owned child sessions are never put into ultracode", () => {
    // They ARE the fan-out; telling them to fan out again is how a run becomes a fork bomb.
    registry.register("child", "run-1")
    onChatMessage({ sessionID: "child" }, chatOutput("ultracode this"))
    expect(mode.isActive("child")).toBe(false)
  })

  test("leaves the variant alone when the mode is off", () => {
    const out = chatOutput("just a normal question")
    onChatMessage({ sessionID: "s1" }, out, { resolveVariant: () => "xhigh" })
    expect(out.message.model.variant).toBeUndefined()
  })
})

const transform = (messages: MessageLike[], options?: { compacting?: boolean; now?: () => number }) =>
  onMessagesTransform({ messages }, options)

describe("messages.transform hook", () => {
  test("injects the reminder when the mode is on", () => {
    mode.enable("s1", "keyword")
    const messages = [userMessage("m1")]
    expect(transform(messages)).toBe(1)
    const injected = messages[0]?.parts?.[0] as Record<string, unknown> | undefined
    expect(String(injected?.["text"])).toBe(ULTRACODE_ON)
  })

  test("injects nothing when the mode is off", () => {
    expect(transform([userMessage("m1")])).toBe(0)
  })

  test("uses the DEMOTED text when the user asked for no fan-out", () => {
    // §1.6: an explicit instruction beats the mode. Effort stays raised; the opt-in does not.
    mode.enable("s1", "keyword")
    mode.demote("s1")
    const messages = [userMessage("m1")]
    transform(messages)
    const injected = messages[0]?.parts?.[0] as Record<string, unknown> | undefined
    expect(String(injected?.["text"])).toBe(ULTRACODE_DEMOTED)
  })

  test("activates from the ultracode AGENT with no stored state", () => {
    expect(transform([userMessage("m1", "s1", "ultracode")])).toBe(1)
  })

  test("skips compaction, whose clone IS sent to the model", () => {
    mode.enable("s1", "keyword")
    expect(transform([userMessage("m1")], { compacting: true })).toBe(0)
  })

  test("skips engine-owned sessions", () => {
    mode.enable("child", "keyword")
    registry.register("child", "run-1")
    expect(transform([userMessage("m1", "child")])).toBe(0)
  })

  test.each([
    ["an empty list", [] as MessageLike[]],
    ["a message with no session id", [{ info: { id: "m1", role: "user" } }] as MessageLike[]],
  ])("handles %s without throwing", (_label, messages) => {
    expect(transform(messages)).toBe(0)
  })
})

describe("chat.params hook", () => {
  test("merges the resolved variant's provider options", () => {
    mode.enable("s1", "keyword")
    const output = { options: { existing: 1 } as Record<string, unknown> }
    onChatParams(
      { sessionID: "s1", model: { variants: { xhigh: { thinking: "adaptive" } } } },
      output,
      { resolveVariant: () => "xhigh" },
    )
    // Merged, not replaced: the host has already assembled options by this point.
    expect(output.options).toEqual({ existing: 1, thinking: "adaptive" })
  })

  test("does nothing when the mode is off, for a child session, or with no session", () => {
    const output = { options: {} as Record<string, unknown> }
    onChatParams({ sessionID: "s1", model: { variants: { xhigh: {} } } }, output, { resolveVariant: () => "xhigh" })
    expect(output.options).toEqual({})

    mode.enable("child", "keyword")
    registry.register("child", "run-1")
    onChatParams({ sessionID: "child", model: { variants: { xhigh: {} } } }, output, { resolveVariant: () => "xhigh" })
    expect(output.options).toEqual({})

    onChatParams({}, output, { resolveVariant: () => "xhigh" })
    expect(output.options).toEqual({})
  })

  test("does nothing when the model has no matching variant", () => {
    mode.enable("s1", "keyword")
    const output = { options: {} as Record<string, unknown> }
    onChatParams({ sessionID: "s1", model: { variants: { low: {} } } }, output, { resolveVariant: () => undefined })
    expect(output.options).toEqual({})
  })

  test("tolerates a missing options bag", () => {
    mode.enable("s1", "keyword")
    expect(() =>
      onChatParams({ sessionID: "s1", model: { variants: { xhigh: {} } } }, {}, { resolveVariant: () => "xhigh" }),
    ).not.toThrow()
  })
})

describe("one-shot keyword — reminder and effort do not leak", () => {
  beforeEach(() => {
    mode.resetForTests()
    registry.resetForTests()
  })

  test("the turn after a keyword turn carries no reminder", () => {
    // A one-shot keyword leaves no reminder behind: the next turn must not be
    // decorated, or the standing fan-out would silently continue.
    const first = chatOutput("ultracode this")
    first.message.id = "m1"
    onChatMessage({ sessionID: "s1" }, first)

    const next = chatOutput("something ordinary")
    next.message.id = "m2"
    onChatMessage({ sessionID: "s1" }, next)

    const output: MessagesTransformOutput = {
      messages: [{ info: { id: "m2", role: "user", sessionID: "s1" }, parts: [] as unknown[] }],
    }
    expect(onMessagesTransform(output)).toBe(0)
    expect(output.messages[0]?.parts?.length ?? 0).toBe(0)
  })

  test("the turn after a keyword turn gets no effort raise either", () => {
    const first = chatOutput("ultracode this")
    onChatMessage({ sessionID: "s1" }, first, { resolveVariant: () => "high" })
    expect(first.message?.model?.variant).toBe("high")

    const next = chatOutput("something ordinary")
    onChatMessage({ sessionID: "s1" }, next, { resolveVariant: () => "high" })
    expect(next.message?.model?.variant).toBeUndefined()
  })

  test("a keyword turn followed by a keyword turn re-arms cleanly (no double reminder)", () => {
    const first = chatOutput("ultracode: audit the diff")
    first.message.id = "m1"
    onChatMessage({ sessionID: "s1" }, first)

    const second = chatOutput("ultracode this too")
    second.message.id = "m2"
    onChatMessage({ sessionID: "s1" }, second)
    expect(mode.isActive("s1")).toBe(true)

    // The decorate path stays idempotent on the re-armed turn.
    const output: MessagesTransformOutput = {
      messages: [{ info: { id: "m2", role: "user", sessionID: "s1" }, parts: [] as unknown[] }],
    }
    const added = onMessagesTransform(output)
    expect(output.messages[0]?.parts?.length ?? 0).toBe(1)
    expect(added).toBe(1)
    expect(onMessagesTransform(output)).toBe(0)
  })
})

describe("live-run runs reminder", () => {
  test("a live background run injects the reminder even with ultracode off", () => {
    // The anchor is not an ultracode feature: any session holding a live run needs it.
    registerPending("wf_runs0001", "s1", 100)
    const messages = [userMessage("m1")]
    expect(transform(messages, { now: () => 61_100 })).toBe(1)
    const part = messages[0]?.parts?.[0] as Record<string, unknown> | undefined
    expect(String(part?.["text"])).toContain("wf_runs0001")
    expect(String(part?.["text"])).toContain("Do not duplicate their work")
    expect(String(part?.["text"])).toContain("1m elapsed")
  })

  test("exactly one reminder per turn — a refire replaces it and carries the fresh elapsed time", () => {
    // The hook can fire more than once per turn; stacking would both waste context and show a
    // stale elapsed time. Replacement keeps exactly one reminder per turn.
    registerPending("wf_runs0002", "s1", 100)
    const messages = [userMessage("m1")]
    transform(messages, { now: () => 1100 })
    transform(messages, { now: () => 2100 })
    expect(messages[0]?.parts?.length).toBe(1)
    const part = messages[0]?.parts?.[0] as Record<string, unknown> | undefined
    expect(String(part?.["text"])).toContain("2s elapsed")
    expect(String(part?.["text"])).not.toContain("1s elapsed")
    expect(String(part?.["id"])).toBe(`${RUNS_REMINDER_PREFIX}m1`)
  })

  test("the reminder disappears once every live run has settled", () => {
    registerPending("wf_runs0003", "s1", 100)
    const messages = [userMessage("m1")]
    expect(transform(messages)).toBe(1)
    dropSettled("wf_runs0003")
    // The host re-reads the rows from the DB each step, so the next turn's messages are fresh —
    // the settled run contributes nothing and the reminder is gone.
    const fresh = [userMessage("m1")]
    expect(transform(fresh)).toBe(0)
    expect(fresh[0]?.parts?.length).toBe(0)
  })

  test("renders one line per run for multiple concurrent runs, in a single reminder", () => {
    registerPending("wf_runs0004", "s1", 100)
    registerPending("wf_runs0005", "s1", 200)
    const messages = [userMessage("m1")]
    expect(transform(messages, { now: () => 2100 })).toBe(1)
    const text = String((messages[0]?.parts?.[0] as Record<string, unknown>)?.["text"])
    expect(text).toContain("wf_runs0004")
    expect(text).toContain("wf_runs0005")
    expect(text.match(/agents spawned so far/gu)).toHaveLength(2)
  })

  test("names the workflow once the launch path knows it, falling back to the run id", () => {
    registerPending("wf_runs0004", "s1", 100)
    nameRun("wf_runs0004", "audit-diff")
    registerPending("wf_runs0005", "s1", 200)
    const messages = [userMessage("m1")]
    transform(messages)
    const text = String((messages[0]?.parts?.[0] as Record<string, unknown>)?.["text"])
    expect(text).toContain('"audit-diff"')
    expect(text).toContain('"wf_runs0005"')
  })

  test("counts agents spawned so far from the engine registry's live children", () => {
    registerPending("wf_runs0006", "s1", 100)
    registry.register("child-a", "wf_runs0006")
    registry.register("child-b", "wf_runs0006")
    const messages = [userMessage("m1")]
    transform(messages)
    const text = String((messages[0]?.parts?.[0] as Record<string, unknown>)?.["text"])
    expect(text).toContain("2 agents spawned so far")
  })

  test("marks the part synthetic and never accumulates it in the re-read rows", () => {
    // Ephemeral by contract: the host re-reads the rows from the DB each step, so nothing the
    // hook adds may reach persistence — a reminder there would accumulate one copy per turn.
    registerPending("wf_runs0007", "s1", 100)
    const messages = [userMessage("m1")]
    transform(messages)
    const part = messages[0]?.parts?.[0] as Record<string, unknown> | undefined
    expect(part?.["synthetic"]).toBe(true)
    const fresh = [userMessage("m1")]
    expect(transform(fresh)).toBe(1)
    expect(fresh[0]?.parts?.length).toBe(1)
  })

  test("decorates only the latest user message", () => {
    registerPending("wf_runs0007", "s1", 100)
    const messages = [userMessage("m1"), userMessage("m2")]
    expect(transform(messages)).toBe(1)
    expect(messages[0]?.parts?.length).toBe(0)
    expect(messages[1]?.parts?.length).toBe(1)
  })

  test("coexists with the ultracode reminder when the mode is on", () => {
    mode.enable("s1", "keyword")
    registerPending("wf_runs0008", "s1", 100)
    const messages = [userMessage("m1"), userMessage("m2")]
    expect(transform(messages)).toBe(3)
    // Earlier messages carry only the ultracode reminder; the last carries both.
    expect(messages[0]?.parts?.length).toBe(1)
    expect(messages[1]?.parts?.length).toBe(2)
    const ids = (messages[1]?.parts ?? []).map((part) => String((part as Record<string, unknown>)?.["id"]))
    expect(ids.some((id) => id.startsWith(RUNS_REMINDER_PREFIX))).toBe(true)
    expect(ids.some((id) => id.startsWith("ultraopen-reminder-"))).toBe(true)
  })

  test("skips engine-owned sessions even while a run is live", () => {
    // Children are the fan-out; a reminder there invites recursion.
    registerPending("wf_runs0009", "s1", 100)
    registry.register("child", "wf_runs0009")
    const messages = [userMessage("m1", "child")]
    expect(transform(messages)).toBe(0)
    expect(messages[0]?.parts?.length).toBe(0)
  })
})

describe("runs reminder — fixed shape and elapsed format", () => {
  test("the same state renders byte-identically — the shape is stable between steps", () => {
    const runs = [run("wf_shape001", "audit-diff", 3, 100)]
    expect(renderRunsReminder(runs, 62_100)).toBe(renderRunsReminder(runs, 62_100))
  })

  test("the template lines are constant across run counts; only per-run lines vary", () => {
    const one = renderRunsReminder([run("wf_shape002", "demo", 1, 100)], 62_100).split("\n")
    const two = renderRunsReminder([run("wf_shape002", "demo", 1, 100), run("wf_shape003", "other", 5, 150)], 62_100)
      .split("\n")
    expect(templateOf(one)).toEqual(templateOf(two))
    expect(one).toHaveLength(6)
    expect(two).toHaveLength(7)
    expect(two[4]).toBe('- wf_shape002 "demo" — 1 agents spawned so far, 1m elapsed')
    expect(two[5]).toBe('- wf_shape003 "other" — 5 agents spawned so far, 1m elapsed')
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

  test("decorateLatest appends once to the last user message and leaves earlier messages alone", () => {
    const messages = [userMessage("m1"), { info: { id: "a1", role: "assistant", sessionID: "s1" }, parts: [] }, userMessage("m2")]
    expect(decorateLatest(messages, "reminder text")).toBe(1)
    expect(messages[0]?.parts?.length).toBe(0)
    expect(messages[1]?.parts?.length).toBe(0)
    expect(messages[2]?.parts?.length).toBe(1)
    expect(decorateLatest(messages, "reminder text")).toBe(1)
    expect(messages[2]?.parts?.length).toBe(1)
  })
})
