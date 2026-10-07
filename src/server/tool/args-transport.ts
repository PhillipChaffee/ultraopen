/**
 * The tool's `args` transport contract at the engine boundary (#78).
 *
 * The boundary is the enforcement point regardless of who stringified the payload — the host
 * tool shim or the model. One inspection, three outcomes:
 *
 * - `hydrate` — the string parses to an object or array: the caller's intent is restored rather
 *   than normalized, and the repair is recorded loudly (manifest + run log). Hashing consumes
 *   the hydrated value, so a hydrated launch and an object-args resume replay as the same run.
 * - `refuse` — either the string LOOKS like JSON (starts with `{` or `[`) but fails to parse, or
 *   the parsed value is too deeply nested to hash for resume: refused naming what was received
 *   and the reason, before any run resource is created.
 * - `pass` — anything else: honest scalar strings, including JSON-parseable scalars like `"42"`,
 *   stay exactly what was passed (the #86 identity contract).
 *
 * The zero-value decorations (`""`, `"null"`, `"undefined"`) are NOT re-decided here: the tool
 * boundary refuses them before this inspection, and a direct engine caller passing them keeps
 * the identity contract — the script sees what was passed.
 */
import { argsHash } from "../resume/key.js"
import { previewValue } from "../script/errors.js"

export type ArgsTransport =
  | { action: "pass" }
  | { action: "hydrate"; value: object; raw: string }
  | { action: "refuse"; raw: string; reason: string }

export function inspectArgsTransport(raw: unknown): ArgsTransport {
  if (typeof raw !== "string") {return { action: "pass" }}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // Only a string that LOOKS like JSON is refused; anything else is an honest scalar.
    return raw.trimStart()[0] === "{" || raw.trimStart()[0] === "["
      ? { action: "refuse", raw, reason: `it looks like JSON but does not parse (${(error as Error).message})` }
      : { action: "pass" }
  }
  if (parsed === null || typeof parsed !== "object") {return { action: "pass" }}
  // The hydrated value must be hashable BEFORE the run exists: a deep-but-parseable payload
  // overflows `argsHash`'s recursion, and discovering that after the permission ask would burn
  // an approval on a launch that can never be recorded.
  try {
    argsHash(parsed)
  } catch {
    return { action: "refuse", raw, reason: "the parsed value is too deeply nested to hash for resume" }
  }
  return { action: "hydrate", value: parsed, raw }
}

/** The one sentence both refusal surfaces state: the tool-boundary block and the engine throw. */
export function stringifiedArgsMessage(raw: string, reason: string): string {
  return `The \`args\` field was passed as the string ${previewValue(raw)} — ${reason}.`
}

/** The one fix both refusal surfaces suggest. */
export const stringifiedArgsSuggestion =
  "Pass the value as real JSON — an object literal, not a quoted string: `args: {\"key\": \"value\"}`."

/**
 * The launch metadata the boundary honors (#142), with its presence rule.
 *
 * A field that is missing, empty, whitespace-only, or one of the documented zero-value
 * decorations (`"null"`, `"undefined"`) is ABSENT everywhere: the manifest omits it (untitled
 * manifests stay byte-identical to the pre-#142 shape) and no surface renders placeholder
 * noise. Models emit those strings for an absent optional field — the same weather the args
 * boundary guards. A present string is recorded and shown verbatim — refusing or dropping the
 * fields is out of scope, and so is decorating an absent one into an empty title.
 */
export function launchMetadataOf(args: { title?: unknown; description?: unknown }): {
  title?: string
  description?: string
} {
  const title = presentMetadata(args.title),
    description = presentMetadata(args.description)
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
  }
}

/** One field's presence: a real non-blank string that is not a zero-value decoration. */
function presentMetadata(value: unknown): string | undefined {
  if (typeof value !== "string") {return undefined}
  const trimmed = value.trim()
  if (trimmed === "" || trimmed === "null" || trimmed === "undefined") {return undefined}
  return value
}

/**
 * The presence rule applied to a title read back OFF a manifest (#142).
 *
 * The manifest is JSON a human can edit, so every reader — the launch registry, the status
 * report, the settle notifications — applies the same rule the launch boundary does, instead
 * of each growing its own guard.
 */
export function manifestTitleOf(title: unknown): string | undefined {
  return presentMetadata(title)
}