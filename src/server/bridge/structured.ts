import { createChild, promptChild } from "./spawn.js"
import type { SpawnOptions, SpawnOutcome } from "./spawn.js"
import { validate } from "./validate.js"
import type { OpencodeClient } from "../types.js"

/**
 * Schema-forced output with a bounded retry ladder.
 *
 * Three facts shape this, all verified against opencode rather than assumed:
 *
 * 1. `format: {type:"json_schema"}` is real — the host injects a StructuredOutput tool, forces the
 *    tool choice, and lands the validated object on `info.structured`. It does NOT prevent the
 *    agent from using ordinary tools first, so a subagent can research and then emit.
 *
 * 2. The host's own `retryCount` is decoded with a default and then never read. Retries are ours.
 *
 * 3. Retries go in the SAME session. That preserves the child's research (often dozens of tool
 *    calls), hits the provider's cache prefix, and is the only construction that repairs a
 *    compaction-stripped `format` — a fresh session cannot, because the repair IS a new
 *    format-bearing user message. It also cannot anchor on the bad output, because the host drops
 *    an errored assistant turn from the messages it sends the model.
 *
 * Three attempts, not five: argument-validation failures already self-repair inside the host's own
 * loop, so the extra attempts were padding.
 */

/** Escalating nudges. Index 0 is the first RETRY, i.e. the second attempt overall. */
const MAX_ATTEMPTS = 3

export type StructuredResult = SpawnOutcome & { attempts: number }

export async function spawnStructured(client: OpencodeClient, options: SpawnOptions): Promise<StructuredResult> {
  const {schema} = options
  if (!schema) {
    const outcome = await runOnce(client, options)
    return { ...outcome, attempts: 1 }
  }

  const created = await createChild(client, options)
  if (!created.ok) {return { ok: false, reason: "spawn-failed", detail: created.detail, attempts: 0 }}
  const {sessionID} = created

  let lastDetail = "no structured output was produced"

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = attempt === 1 ? options.prompt : nudge(attempt, schema, lastDetail),
     outcome = await promptChild(client, sessionID, prompt, options)

    // Only a schema miss is worth retrying. An abort, a deadline or a context overflow will not
    // improve by asking again — and retrying an aborted run would fight the user.
    if (outcome.ok) {
      const verdict = validate(outcome.structured, schema)
      if (verdict.valid) {return { ...outcome, attempts: attempt }}

      // The host validates against the schema it was given, so a mismatch here means the value
      // came back through a path that skipped that check — exactly the compaction case.
      lastDetail = verdict.errors.slice(0, 4).join("; ")
      continue
    }

    if (outcome.reason !== "schema-failed") {return { ...outcome, attempts: attempt }}
    lastDetail = outcome.detail
  }

  return {
    ok: false,
    reason: "schema-failed",
    detail: `no valid structured output after ${MAX_ATTEMPTS} attempts — ${lastDetail}`,
    sessionID,
    attempts: MAX_ATTEMPTS,
  }
}

async function runOnce(client: OpencodeClient, options: SpawnOptions): Promise<SpawnOutcome> {
  const created = await createChild(client, options)
  if (!created.ok) {return { ok: false, reason: "spawn-failed", detail: created.detail }}
  return await promptChild(client, created.sessionID, options.prompt, options)
}

/**
 * Builds the retry prompt, escalating with each attempt.
 *
 * Attempt 2 names the required keys and their types, which is enough for most misses. Attempt 3
 * additionally flattens the schema into a worked example, because the usual remaining cause is a
 * nested `oneOf`/`$ref` the model could not satisfy.
 */
function nudge(attempt: number, schema: Record<string, unknown>, detail: string): string {
  const required = requiredSummary(schema),
   lines = [
    "Your previous reply did not produce valid structured output.",
    `Problem: ${detail}`,
    "",
    "Call the StructuredOutput tool with a value matching the required schema.",
  ]

  if (required.length > 0) {
    lines.push("", "Required fields:", ...required.map((entry) => `  - ${entry}`))
  }

  if (attempt >= 3) {
    lines.push(
      "",
      "A valid shape looks like this — match it exactly, with no extra keys and no nesting that",
      "the schema does not describe:",
      JSON.stringify(exampleFor(schema), null, 2),
    )
  }

  return lines.join("\n")
}

function requiredSummary(schema: Record<string, unknown>): string[] {
  const {required} = schema
  const {properties} = schema
  if (!Array.isArray(required) || typeof properties !== "object" || properties === null) {return []}

  const props = properties as Record<string, unknown>
  return required
    .filter((key): key is string => typeof key === "string")
    .map((key) => {
      const sub = props[key],
       type = typeof sub === "object" && sub !== null ? (sub as Record<string, unknown>)["type"] : undefined,
       describedAs = typeof type === "string" ? type : "value"
      return `${key} (${describedAs})`
    })
}

/** A minimal example instance, used only as a last-resort nudge. */
function exampleFor(schema: Record<string, unknown>): unknown {
  const {type} = schema

  if (type === "object" || schema["properties"] !== undefined) {
    const {properties} = schema
    if (typeof properties !== "object" || properties === null) {return {}}
    const out: Record<string, unknown> = {}
    for (const [key, sub] of Object.entries(properties as Record<string, unknown>)) {
      if (typeof sub === "object" && sub !== null) {out[key] = exampleFor(sub as Record<string, unknown>)}
    }
    return out
  }

  if (type === "array") {
    const {items} = schema
    return typeof items === "object" && items !== null ? [exampleFor(items as Record<string, unknown>)] : []
  }

  const enumValues = schema["enum"]
  if (Array.isArray(enumValues) && enumValues.length > 0) {return enumValues[0]}

  switch (type) {
    case "string": {
      return "…"
    }
    case "number":
    case "integer": {
      return 0
    }
    case "boolean": {
      return false
    }
    case "null": {
      return null
    }
    default: {
      return "…"
    }
  }
}
