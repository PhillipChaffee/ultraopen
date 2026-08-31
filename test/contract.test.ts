import { describe, expect, test } from "bun:test"
import { CONTRACTS, subagentContract } from "../src/server/bridge/contract.js"
import type { AgentOptions } from "../src/server/runtime/run.js"

describe("contract selection", () => {
  test("plain call gets the return-value contract", () => {
    expect(subagentContract({})).toBe(CONTRACTS.returnValue)
  })

  test("a schema'd call gets the StructuredOutput contract", () => {
    expect(subagentContract({ schema: { type: "object" } })).toBe(CONTRACTS.schema)
  })

  test("a pinned agentType gets an additive NOTE, not a replacement", () => {
    // That agent already has its own instructions; a full contract would read as superseding them.
    expect(subagentContract({ agentType: "explore" })).toBe(CONTRACTS.agentTypeNote)
  })

  test("a pinned agentType with a schema gets the schema NOTE", () => {
    expect(subagentContract({ agentType: "explore", schema: { type: "object" } })).toBe(
      CONTRACTS.agentTypeSchemaNote,
    )
  })

  test("an empty agentType is treated as unpinned", () => {
    expect(subagentContract({ agentType: "" })).toBe(CONTRACTS.returnValue)
  })

  test("every combination yields a contract — a subagent is never left uninstructed", () => {
    // Built explicitly rather than by spreading undefined, which exactOptionalPropertyTypes
    // rejects: an absent key and a key set to undefined are different things here.
    const combinations: AgentOptions[] = [
      {},
      { agentType: "explore" },
      { schema: { type: "object" } },
      { agentType: "explore", schema: { type: "object" } },
    ]
    for (const options of combinations) expect(subagentContract(options)).toBeTruthy()
  })
})

describe("contract content", () => {
  test("the note variants read as additive so they cannot override the agent's own prompt", () => {
    for (const note of [CONTRACTS.agentTypeNote, CONTRACTS.agentTypeSchemaNote]) {
      expect(note.startsWith("\n\n---\n\nNOTE:")).toBe(true)
      expect(note).toContain("Follow your own instructions")
    }
  })

  test("the non-schema contracts tell the agent its text IS the return value", () => {
    // Without this, models write conversational wrappers that the calling script must parse around.
    expect(CONTRACTS.returnValue).toContain("return value")
    expect(CONTRACTS.agentTypeNote).toContain("return value")
  })

  test("the schema contracts name the StructuredOutput tool the host actually injects", () => {
    expect(CONTRACTS.schema).toContain("StructuredOutput")
    expect(CONTRACTS.agentTypeSchemaNote).toContain("StructuredOutput")
  })

  test("the schema contract tells the agent to research BEFORE emitting", () => {
    // toolChoice:"required" does not block ordinary tool use, so an agent that emits immediately
    // is leaving its actual job undone.
    expect(CONTRACTS.schema).toContain("Do the work FIRST")
  })

  test("every contract discourages fabrication when blocked", () => {
    expect(CONTRACTS.returnValue).toContain("fabrication")
    expect(CONTRACTS.schema).toContain("rather than inventing")
  })
})
