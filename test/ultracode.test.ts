import { beforeEach, describe, expect, test } from "bun:test"
import { mentionsKeyword, mode, requestsNoFanOut } from "../src/server/ultracode/mode.js"
import { decorate, REMINDER_MARKER, ULTRACODE_DEMOTED, ULTRACODE_ON } from "../src/server/ultracode/reminders.js"
import type { MessageLike } from "../src/server/ultracode/reminders.js"
import { onChatMessage, onChatParams, onMessagesTransform } from "../src/server/ultracode/hooks.js"
import { registry } from "../src/server/singleton.js"

beforeEach(() => {
  mode.resetForTests()
  registry.resetForTests()
})

const userMessage = (id: string, sessionID = "s1", agent?: string): MessageLike => ({
  info: { id, role: "user", sessionID, ...(agent ? { agent } : {}) },
  parts: [],
})

describe("keyword detection", () => {
  test.each([
    ["use ultracode for this", true],
    ["ULTRACODE please", true],
    ["let's ultracode it", true],
    ["ultracoded output", false],
    // `/` and `.` are word boundaries, so a filename mention matches. Accepted: the cost is one
    // turn at higher effort, and it is visible rather than silent.
    ["src/ultracode.ts", true],
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

  test("re-mentioning the keyword while active does NOT move the reminder toggle point", () => {
    // The reminder is ephemeral and re-injected from `fromMessageID` each turn; overwriting it
    // with each new mention drops earlier messages' reminders and breaks the cache prefix.
    const first = chatOutput("ultracode this")
    first.message.id = "m1"
    onChatMessage({ sessionID: "s1" }, first)
    const stateBefore = mode.get("s1")
    expect(stateBefore?.fromMessageID).toBe("m1")

    const again = chatOutput("more ultracode please")
    again.message.id = "m2"
    onChatMessage({ sessionID: "s1" }, again)
    expect(mode.get("s1")?.fromMessageID).toBe("m1")
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

const transform = (messages: MessageLike[], options?: { compacting?: boolean }) =>
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
