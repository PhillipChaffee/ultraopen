import { describe, expect, test } from "bun:test"
import { Plugin } from "@opencode/plugin"
import type { SessionMessage } from "@opencode/schema/session-message"
import { ensureMessageId } from "../../src/server/host/v2-adapter.js"
import type { CreateChildSessionInput } from "../../src/server/host/port.js"
import { UltraopenRpc } from "../../src/rpc.js"
import type { Rpc } from "@opencode/plugin/rpc"

/**
 * V2.3.2 contract pins.
 *
 * These are compile-time and structural assertions against the INSTALLED `@opencode/plugin@2.3.2`,
 * not captured source strings from a previous release. A rename upstream makes `tsc` fail here
 * before the plugin fails at runtime.
 */

type Context = Plugin.Context

// The domains and methods the plugin actually drives must remain on `Context`.
const SESSION_METHODS: (keyof Context["session"])[] = [
  "create",
  "get",
  "move",
  "prompt",
  "wait",
  "context",
  "synthetic",
  "interrupt",
]
const PERMISSION_METHODS: (keyof Context["permission"])[] = ["assert", "list", "reply", "hook"]
const RPC_METHODS: (keyof Context["rpc"])[] = ["register"]

// Assignability: the real context satisfies the pieces the adapter and hooks use.
const _sessionSurface: Pick<Context["session"], "create" | "get" | "move" | "prompt" | "wait" | "context" | "synthetic" | "interrupt"> =
  {} as Context["session"]
const _permissionSurface: Pick<Context["permission"], "assert" | "list" | "reply" | "hook"> = {} as Context["permission"]
const _rpcSurface: Pick<Context["rpc"], "register"> = {} as Context["rpc"]
const _toolSurface: Pick<Context["tool"], "transform" | "hook"> = {} as Context["tool"]
const _shellSurface: Pick<Context["shell"], "hook"> = {} as Context["shell"]
const _eventSurface: Pick<Context["event"], "subscribe"> = {} as Context["event"]
const _agentSurface: Pick<Context["agent"], "transform" | "list"> = {} as Context["agent"]
const _commandSurface: Pick<Context["command"], "transform" | "reload"> = {} as Context["command"]
const _skillSurface: Pick<Context["skill"], "transform"> = {} as Context["skill"]

void _sessionSurface
void _permissionSurface
void _rpcSurface
void _toolSurface
void _shellSurface
void _eventSurface
void _agentSurface
void _commandSurface
void _skillSurface

// `Plugin.Context` is a namespace type, not a top-level export.
type _ContextIsNamespace = Context extends { readonly session: unknown } ? true : never
const _contextIsNamespace: _ContextIsNamespace = true
void _contextIsNamespace

// The V1 client and config hook are gone: this context exposes no `client` field.
// @ts-expect-error V2's Context has no `client`
const _noClient: unknown = ({} as Context).client
void _noClient

describe("installed @opencode/plugin@2.3.2", () => {
  test("Plugin.define exists and returns the plugin unchanged", () => {
    expect(typeof Plugin.define).toBe("function")
    const defined = Plugin.define({ id: "probe", setup: () => {} })
    expect(defined.id).toBe("probe")
    expect(typeof defined.setup).toBe("function")
  })

  test("the context carries every session method the adapter drives", () => {
    expect(SESSION_METHODS).toEqual([
      "create",
      "get",
      "move",
      "prompt",
      "wait",
      "context",
      "synthetic",
      "interrupt",
    ])
  })

  test("the permission domain carries assert, list, reply and hook", () => {
    expect(PERMISSION_METHODS).toEqual(["assert", "list", "reply", "hook"])
  })

  test("the RPC domain carries register", () => {
    expect(RPC_METHODS).toEqual(["register"])
  })

  test("UltraopenRpc is a portable V2 definition with listRuns, stopRun and runUpdated", () => {
    const _portable: Rpc.PortableDefinition = UltraopenRpc
    void _portable
    expect(UltraopenRpc.id).toBe("ultraopen")
    expect(UltraopenRpc.methods.listRuns).toBeDefined()
    expect(UltraopenRpc.methods.stopRun).toBeDefined()
    expect(UltraopenRpc.events.runUpdated).toBeDefined()
  })
})

describe("session message ids", () => {
  test("the host enforces a non-empty msg_ prefix, and the adapter mirrors it", () => {
    const id: SessionMessage.ID = "msg_00000000000000000000000000000001" as SessionMessage.ID
    expect(ensureMessageId(id)).toBe(id)
    expect(() => ensureMessageId("ses_not_a_message")).toThrow(/msg_/u)
    expect(() => ensureMessageId("")).toThrow(/msg_/u)
  })
})

describe("CreateChildSessionInput", () => {
  test("omits parentID so the host's SubagentReport can never fire on a workflow child", () => {
    const input: CreateChildSessionInput = {
      title: "ultraopen · worker",
      metadata: { ultraopen: { runId: "run-1" } },
    }
    expect("parentID" in input).toBe(false)
    // @ts-expect-error `parentID` is deliberately unrepresentable
    const _bad: CreateChildSessionInput = { title: "x", metadata: {}, parentID: "ses_parent" }
    void _bad
  })
})
