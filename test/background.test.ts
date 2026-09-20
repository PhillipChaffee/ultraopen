import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  HYDRATION_CAP,
  HYDRATION_NOTIFICATION_RE,
  capAtLineBoundary,
  deliverOutcome,
  dropPending,
  dropSettled,
  hydrateParent,
  isLive,
  isLiveAnywhere,
  isProcessAlive,
  liveRunsForSession,
  onSessionIdle,
  promote,
  registerPending,
  renderNotification,
  resetForTests,
  runDetached,
  settlePromiseOf,
  siblingRunsForSession,
} from "../src/server/tool/background.js"
import { artifactPaths } from "../src/server/resume/store.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OpencodeClient } from "../src/server/types.js"

/** A task whose own failure path is itself broken — the harness must still record it. */
const BROKEN_TASK = (): Promise<void> => Promise.reject(new Error("the failure path itself broke"))

/** Records that the harness's escape hatch fired; index.ts supplies the real one. */
const ESCAPE_RECORDER = (_error: unknown): Promise<void> => Promise.resolve()

/** A stand-in renderFailure; background.ts only forwards it. */
const FAKE_RENDER: (error: unknown) => string = String

const manifest = (over: Partial<Parameters<typeof isLiveAnywhere>[0]> = {}) => ({
  runId: "wf_bgtarget1",
  bootId: "boot-a",
  pid: process.pid,
  sessionID: "parent",
  sourceHash: "h",
  argsHash: "a",
  status: "running" as const,
  childSessionIDs: [],
  startedAt: 1,
  ...over,
})

beforeEach(() => {
  resetForTests()
})

describe("launch-gating registry", () => {
  test("registerPending makes a run live for its session, synchronously", () => {
    registerPending("wf_bg000001", "s1")
    expect(liveRunsForSession("s1")[0]?.runId).toBe("wf_bg000001")
    expect(liveRunsForSession("s1")[0]?.status).toBe("pending")
    expect(isLive("wf_bg000001")).toBe(true)
  })

  test("promote moves pending to running", () => {
    registerPending("wf_bg000002", "s1")
    promote("wf_bg000002")
    expect(liveRunsForSession("s1")[0]?.status).toBe("running")
  })

  test("dropPending removes only pending entries", () => {
    registerPending("wf_bg000003", "s1")
    dropPending("wf_bg000003")
    expect(liveRunsForSession("s1")).toHaveLength(0)
    // A running entry is launch-gating state, not launch residue; dropping it
    // would let a second run slip past the refusal.
    registerPending("wf_bg000004", "s1")
    promote("wf_bg000004")
    dropPending("wf_bg000004")
    expect(liveRunsForSession("s1")[0]?.runId).toBe("wf_bg000004")
  })

  test("dropSettled removes the entry whatever status it reached", () => {
    // The blocking contract holds its gate entry from registration to settle;
    // settle cleanup must land even if the entry was promoted along the way,
    // or a settled run would strand the session gate and the resume refusal.
    registerPending("wf_bg000009", "s1")
    dropSettled("wf_bg000009")
    expect(liveRunsForSession("s1")).toHaveLength(0)
    registerPending("wf_bg000010", "s1")
    promote("wf_bg000010")
    dropSettled("wf_bg000010")
    expect(liveRunsForSession("s1")).toHaveLength(0)
  })

  test("entries are scoped per session and dropped on settle", async () => {
    registerPending("wf_bg000005", "s1")
    await runDetached({ runId: "wf_bg000005", manifest: undefined, task: async () => {}, renderFailure: FAKE_RENDER, onEscapedRejection: ESCAPE_RECORDER })
    expect(liveRunsForSession("s1")).toHaveLength(0)
    expect(liveRunsForSession("s2")).toHaveLength(0)
  })

  test("each session sees only its own live run", () => {
    registerPending("wf_bg000006", "s1")
    registerPending("wf_bg000007", "s2")
    expect(liveRunsForSession("s1")[0]?.runId).toBe("wf_bg000006")
    expect(liveRunsForSession("s2")[0]?.runId).toBe("wf_bg000007")
  })

  test("the session query returns EVERY live entry, oldest start first", () => {
    // Stamps are injectable so the order contract is pinned independently of the
    // clock: out-of-order registration sorts by start time, and entries stamped
    // in the same millisecond keep registration order (the registry inserts
    // each entry in the same synchronous step as its stamp, so insertion
    // order IS start order).
    registerPending("wf_bg000011", "s1", 300)
    registerPending("wf_bg000012", "s2", 100)
    registerPending("wf_bg000013", "s1", 200)
    registerPending("wf_bg000014", "s1", 200)
    expect(liveRunsForSession("s1").map((entry) => entry.runId)).toEqual([
      "wf_bg000013",
      "wf_bg000014",
      "wf_bg000011",
    ])
    // Another session's entries never leak in.
    expect(liveRunsForSession("s2").map((entry) => entry.runId)).toEqual(["wf_bg000012"])
  })

  test("the session query carries each entry's status, pending and running alike", () => {
    registerPending("wf_bg000015", "s1")
    registerPending("wf_bg000016", "s1")
    promote("wf_bg000015")
    const live = liveRunsForSession("s1")
    expect(live.map((entry) => entry.status)).toEqual(["running", "pending"])
  })

  test("the sibling query excludes the named run and keeps start order", () => {
    registerPending("wf_bg000016", "s1", 100)
    registerPending("wf_bg000017", "s1", 200)
    registerPending("wf_bg000018", "s1", 300)
    expect(siblingRunsForSession("s1", "wf_bg000017").map((entry) => entry.runId)).toEqual([
      "wf_bg000016",
      "wf_bg000018",
    ])
    // An unknown id excludes nothing: every live entry is a sibling.
    expect(siblingRunsForSession("s1", "wf_bg000019").map((entry) => entry.runId)).toEqual([
      "wf_bg000016",
      "wf_bg000017",
      "wf_bg000018",
    ])
  })

  test("resetForTests restores clean module state", () => {
    registerPending("wf_bg000008", "s1")
    resetForTests()
    expect(liveRunsForSession("s1")).toHaveLength(0)
  })
})

describe("isLiveAnywhere", () => {
  test("a completed or failed manifest is never live", () => {
    expect(isLiveAnywhere(manifest({ status: "completed" }), "boot-a")).toBe(false)
    expect(isLiveAnywhere(manifest({ status: "failed" }), "boot-a")).toBe(false)
    expect(isLiveAnywhere(manifest({ status: "orphaned" }), "boot-a")).toBe(false)
  })

  test("this boot defers to the local registry, which knows pending and running", () => {
    const target = manifest({ bootId: "boot-a", runId: "wf_bgtarge" })
    // Not registered: not live, even from this boot.
    expect(isLiveAnywhere(target, "boot-a")).toBe(false)
    registerPending("wf_bgtarge", "s1")
    expect(isLiveAnywhere(target, "boot-a")).toBe(true)
  })

  test("another boot's run is live while its pid is alive and dead otherwise", () => {
    expect(isLiveAnywhere(manifest({ bootId: "boot-b", pid: process.pid }), "boot-a")).toBe(true)
    expect(isLiveAnywhere(manifest({ bootId: "boot-b", pid: 2 ** 28 }), "boot-a")).toBe(false)
  })

  test("isProcessAlive detects a dead pid without throwing", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    // A pid far above the platform maximum is dead by construction; -1 is a
    // broadcast, not a dead pid, so it is never a valid probe target.
    expect(isProcessAlive(2 ** 30)).toBe(false)
  })
})

describe("runDetached", () => {
  let dataHome: string,
   savedXDG: string | undefined

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "ultraopen-bg-"))
    savedXDG = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = dataHome
  })

  afterEach(async () => {
    if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
    else {process.env["XDG_DATA_HOME"] = savedXDG}
    await rm(dataHome, { recursive: true, force: true })
  })

  test("clears the launch-gating state and the settle handle when the task resolves", async () => {
    registerPending("wf_bg000100", "s1")
    const pending = runDetached({ runId: "wf_bg000100", manifest: undefined, task: async () => {}, renderFailure: FAKE_RENDER, onEscapedRejection: ESCAPE_RECORDER })
    // The handle must exist while the task is in flight.
    expect(settlePromiseOf("wf_bg000100")).toBeDefined()
    await pending
    expect(liveRunsForSession("s1")).toHaveLength(0)
    // After settle the handle is gone: a late await resolves immediately rather
    // than returning the settled promise (or hanging).
    await settlePromiseOf("wf_bg000100")
  })

  test("an escaping rejection routes to the caller's degraded settle", async () => {
    // The task was supposed to capture its own outcome; an escaping rejection
    // means that capture itself broke, so the harness must hand the error to
    // the caller's callback (which owns the flush chain) instead of dropping it.
    const seen: unknown[] = []
    await runDetached({
      runId: "wf_bg000101",
      manifest: undefined,
      task: BROKEN_TASK,
      renderFailure: FAKE_RENDER,
      onEscapedRejection: (error): Promise<void> => {
        seen.push(error)
        return Promise.resolve()
      },
    })
    expect(seen.length).toBe(1)
    expect((seen[0] as Error).message).toContain("the failure path itself broke")
  })

  test("a settled run's children are dropped from the engine registry", async () => {
    registerPending("wf_bg000102", "s1")
    const { registry } = await import("../src/server/singleton.js")
    registry.register("child-a", "wf_bg000102")
    await runDetached({ runId: "wf_bg000102", manifest: undefined, task: async () => {}, renderFailure: FAKE_RENDER, onEscapedRejection: ESCAPE_RECORDER })
    expect(registry.owns("child-a")).toBe(false)
  })
})

describe("settlePromiseOf", () => {
  test("resolves immediately for an unknown run", () => {
    // A status tool that asks about a never-launched run must not hang.
    expect(settlePromiseOf("wf_nothere1")).toBeDefined()
  })
})
describe("runDetached — unwritable disk", () => {
  test("a failure write that itself fails is swallowed; the run still settles", async () => {
    // XDG under /dev/null can never be written: writeFailure rejects, its catch
    // fires, and the harness must still finish quietly.
    resetForTests()
    registerPending("wf_bg000200", "s1")
    const savedXDG = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = "/dev/null/nope"
    try {
      await runDetached({ runId: "wf_bg000200", manifest: undefined, task: BROKEN_TASK, renderFailure: FAKE_RENDER, onEscapedRejection: ESCAPE_RECORDER })
      expect(liveRunsForSession("s1")).toHaveLength(0)
    } finally {
      if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
      else {process.env["XDG_DATA_HOME"] = savedXDG}
    }
  })
})

/** A hand-rolled fake client — records promptAsync deliveries and serves canned reads. */
function fakeClient(options: {
  agent?: string
  messages?: { info: { role: string }; parts: { type: string; text?: string }[] }[]
  failPromptAsync?: boolean
}): { client: OpencodeClient; sent: { sessionID: string; text: string; agent?: string }[] } {
  const sent: { sessionID: string; text: string; agent?: string }[] = []
  const client = {
    session: {
      get: () => Promise.resolve({ data: { id: "parent", ...(options.agent === undefined ? {} : { agent: options.agent }) } }),
      promptAsync: (call: { path: { id: string }; body: { parts: { text: string }[]; agent?: string } }) => {
        if (options.failPromptAsync === true) {return Promise.reject(new Error("transport down"))}
        const agent = call.body.agent
        sent.push({ sessionID: call.path.id, text: call.body.parts[0]?.text ?? "", ...(agent === undefined ? {} : { agent }) })
        return Promise.resolve({ data: undefined })
      },
      messages: () => Promise.resolve({ data: options.messages ?? [] }),
    },
  } as unknown as OpencodeClient
  return { client, sent }
}

/** A canned transcript row: our notification as a session's last user message. */
const notificationRow = (runId: string): { info: { role: string }; parts: { type: string; text?: string }[] } => ({
  info: { role: "user" },
  parts: [{ type: "text", text: `<workflow-completed run="${runId}" workflow="demo">\nthe value\n</workflow-completed>\nfull result: /tmp/x` }],
})

describe("hydration — capAtLineBoundary", () => {
  test("under the cap the whole text hydrates", () => {
    const text = "line one\nline two\nline three"
    expect(capAtLineBoundary(text)).toBe(text)
  })

  test("over the cap, whole lines are kept and no line is ever split", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i}-${"x".repeat(40)}`),
      text = lines.join("\n")
    const capped = capAtLineBoundary(text)
    expect(capped.length).toBeLessThanOrEqual(HYDRATION_CAP)
    for (const line of capped.split("\n")) {
      expect(lines).toContain(line)
    }
    expect(capped.startsWith(lines[0] ?? "")).toBe(true)
  })

  test("a single over-cap line survives whole rather than degrading to empty", () => {
    const huge = "y".repeat(HYDRATION_CAP + 500)
    expect(capAtLineBoundary(huge)).toBe(huge)
  })

  test("the default cap is the documented 4KB policy", () => {
    expect(HYDRATION_CAP).toBe(4096)
  })
})

describe("hydration — renderNotification", () => {
  let dataHome: string,
   savedXDG: string | undefined

  beforeEach(async () => {
    dataHome = await mkdtemp(join(tmpdir(), "ultraopen-hydration-"))
    savedXDG = process.env["XDG_DATA_HOME"]
    process.env["XDG_DATA_HOME"] = dataHome
  })

  afterEach(async () => {
    if (savedXDG === undefined) {delete process.env["XDG_DATA_HOME"]}
    else {process.env["XDG_DATA_HOME"] = savedXDG}
    await rm(dataHome, { recursive: true, force: true })
  })

  test("a completion wraps the body in the marker and points at result.json", () => {
    const text = renderNotification({ status: "completed", name: "demo", runId: "wf_hyd0001", body: "the value" })
    expect(text).toContain('<workflow-completed run="wf_hyd0001" workflow="demo">')
    expect(text).toContain("the value")
    expect(text).toContain("</workflow-completed>")
    expect(text).toContain(`full result: ${artifactPaths("wf_hyd0001").resultPath}`)
  })

  test("a failure wraps in the failed marker and points at failure.txt", () => {
    const text = renderNotification({ status: "failed", name: "demo", runId: "wf_hyd0001", body: "it broke" })
    expect(text).toContain('<workflow-failed run="wf_hyd0001" workflow="demo">')
    expect(text).toContain("it broke")
    expect(text).toContain(`full failure: ${artifactPaths("wf_hyd0001").failurePath}`)
  })

  test("an over-cap body is capped but the pointer line always survives the cut", () => {
    const body = Array.from({ length: 400 }, (_, i) => `row-${i}-${"z".repeat(30)}`).join("\n")
    const text = renderNotification({ status: "completed", name: "demo", runId: "wf_hyd0001", body })
    expect(text.length).toBeLessThan(HYDRATION_CAP + 200)
    expect(text.endsWith(artifactPaths("wf_hyd0001").resultPath)).toBe(true)
  })
})

describe("hydration — hydrateParent and deliverOutcome", () => {
  test("fires exactly one promptAsync to the parent with the rendered notification", async () => {
    const { client, sent } = fakeClient({})
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.sessionID).toBe("parent")
    expect(sent[0]?.text).toContain('<workflow-completed run="wf_hyd0001"')
  })

  test("passes the parent session's stored agent so the prompt does not fall back to the default agent", async () => {
    const { client, sent } = fakeClient({ agent: "plan" })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    expect(sent[0]?.agent).toBe("plan")
  })

  test("an absent stored agent is omitted from the body, not sent as undefined", async () => {
    const { client, sent } = fakeClient({})
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    expect(sent[0]?.agent).toBeUndefined()
  })

  test("a failed delivery never rejects — the settle protocol already closed the manifest", async () => {
    const { client } = fakeClient({ failPromptAsync: true })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "failed", name: "demo", runId: "wf_hyd0001", body: "x" } })
  })

  test("deliverOutcome renders the completed shape from the shared renderResult", async () => {
    const { client, sent } = fakeClient({})
    await deliverOutcome({
      client,
      sessionID: "parent",
      runId: "wf_hyd0001",
      workflow: "demo",
      result: { runId: "wf_hyd0001", meta: { name: "demo", description: "d" }, value: "OUTCOME", agentCount: 1, nulls: [], logs: [], outputTokens: 0, journal: [], childSessionIDs: [] },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('<workflow-completed run="wf_hyd0001" workflow="demo">')
    expect(sent[0]?.text).toContain("OUTCOME")
    expect(sent[0]?.text).toContain("<usage ")
  })

  test("deliverOutcome renders the failed shape from the failure text", async () => {
    const { client, sent } = fakeClient({})
    await deliverOutcome({ client, sessionID: "parent", runId: "wf_hyd0001", workflow: "demo", failureText: "it exploded" })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toContain('<workflow-failed run="wf_hyd0001" workflow="demo">')
    expect(sent[0]?.text).toContain("it exploded")
  })
})

describe("hydration — onSessionIdle (the missed-wake nudge)", () => {
  test("re-fires once when the last message is our unanswered notification", async () => {
    const { client, sent } = fakeClient({ messages: [notificationRow("wf_hyd0001")] })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "the value" } })
    await onSessionIdle(client, "parent")
    expect(sent).toHaveLength(2)
    expect(sent[1]?.text).toContain('<workflow-nudge run="wf_hyd0001"')
    expect(sent[1]?.text).toContain('workflow="demo"')
  })

  test("once, ever: a second idle does not stack another nudge", async () => {
    const { client, sent } = fakeClient({ messages: [notificationRow("wf_hyd0001")] })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    await onSessionIdle(client, "parent")
    await onSessionIdle(client, "parent")
    expect(sent).toHaveLength(2)
  })

  test("a last user message that is not ours drops the pending entry without a nudge", async () => {
    const { client, sent } = fakeClient({
      messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "a normal user turn" }] }],
    })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    await onSessionIdle(client, "parent")
    expect(sent).toHaveLength(1)
  })

  test("a run already nudged is never nudged again, even if its notification re-arms", async () => {
    const { client, sent } = fakeClient({ messages: [notificationRow("wf_hyd0001")] })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    await onSessionIdle(client, "parent")
    // One hydration delivery plus one nudge.
    expect(sent).toHaveLength(2)
    // The same run hydrating again re-arms the pending entry (that delivery is sent[2]),
    // but the once-ever guard holds: the second idle must not stack another nudge.
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    expect(sent).toHaveLength(3)
    await onSessionIdle(client, "parent")
    expect(sent).toHaveLength(3)
  })

  test("an assistant answer after the notification means no nudge", async () => {
    const { client, sent } = fakeClient({
      messages: [notificationRow("wf_hyd0001"), { info: { role: "assistant" }, parts: [] }],
    })
    await hydrateParent({ client, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    await onSessionIdle(client, "parent")
    expect(sent).toHaveLength(1)
  })

  test("a session never hydrated here is not even listed", async () => {
    const { client, sent } = fakeClient({ messages: [notificationRow("wf_hyd0001")] })
    await onSessionIdle(client, "stranger")
    expect(sent).toHaveLength(0)
  })

  test("a listing failure keeps the pending entry for the next idle and never throws", async () => {
    const failing = {
      session: {
        get: () => Promise.resolve({ data: { id: "parent" } }),
        promptAsync: () => Promise.resolve({ data: undefined }),
        messages: () => Promise.reject(new Error("server hiccup")),
      },
    } as unknown as OpencodeClient
    await hydrateParent({ client: failing, sessionID: "parent", outcome: { status: "completed", name: "demo", runId: "wf_hyd0001", body: "v" } })
    await onSessionIdle(failing, "parent")
    const { client, sent } = fakeClient({ messages: [notificationRow("wf_hyd0001")] })
    await onSessionIdle(client, "parent")
    expect(sent).toHaveLength(1)
  })
})

describe("hydration — HYDRATION_NOTIFICATION_RE", () => {
  test("recognises both markers and captures the run id", () => {
    expect(HYDRATION_NOTIFICATION_RE.exec('<workflow-completed run="wf_hyd0001" workflow="x">')?.groups?.["runId"]).toBe("wf_hyd0001")
    expect(HYDRATION_NOTIFICATION_RE.exec('<workflow-failed run="wf_hyd0001" workflow="x">')?.groups?.["runId"]).toBe("wf_hyd0001")
    expect(HYDRATION_NOTIFICATION_RE.exec('<workflow-nudge run="wf_hyd0001">')).toBeNull()
    expect(HYDRATION_NOTIFICATION_RE.exec("some other message")).toBeNull()
  })
})
