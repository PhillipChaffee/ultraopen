import * as acorn from "acorn"
import { fail } from "./errors.js"
import { MAX_SCRIPT_CHARS } from "./limits.js"
import { lintDeterminism } from "./lint.js"
import { extractMeta, type Meta } from "./meta.js"

export type ParsedScript = {
  meta: Meta
  /** Source with every `export ` keyword blanked in place. Byte offsets are preserved. */
  body: string
  ast: acorn.Program
}

/**
 * Parses and validates a workflow script.
 *
 * Order matters: size guard, then parse (which rejects TypeScript for free — acorn has no TS
 * plugin), then static meta extraction (before ANY code runs, because the permission dialog and
 * workflow list need it), then the determinism/Node lint.
 */
export function parse(source: string): ParsedScript {
  if (source.length > MAX_SCRIPT_CHARS) {
    fail({
      kind: "LimitError",
      message: `Workflow script is ${source.length} characters; the limit is ${MAX_SCRIPT_CHARS}.`,
      suggestions: ["Move large constant data into `args` instead of embedding it in the script."],
    })
  }

  let ast: acorn.Program
  try {
    ast = acorn.parse(source, {
      ecmaVersion: "latest",
      // `module` is what makes BOTH top-level `export const meta` and top-level `await` legal
      // without wrapping the body — wrapping is what would destroy the export.
      sourceType: "module",
      // The spec's scripts end with a top-level `return` (e.g. `return { confirmed }`), which
      // module mode rejects by default. The body really does become a function body, so allowing
      // it here matches how the script actually executes.
      allowReturnOutsideFunction: true,
      locations: true,
      ranges: true,
    })
  } catch (error) {
    const syntaxError = error as Error & { loc?: { line: number; column: number } }
    fail({
      kind: "ParseError",
      message: `Workflow scripts are plain JavaScript, not TypeScript. ${syntaxError.message}`,
      location: syntaxError.loc ? { line: syntaxError.loc.line, column: syntaxError.loc.column } : undefined,
      suggestions: [
        "Remove type annotations (`: string[]`), interfaces, and generics — they are not valid JavaScript.",
        "The script body runs in an async context, so top-level `await` is fine.",
      ],
    })
  }

  const meta = extractMeta(ast)
  lintDeterminism(ast)

  return { meta, body: blankExports(ast, source), ast }
}

/**
 * Blanks EVERY `export ` keyword in place, preserving byte offsets.
 *
 * Offset preservation is what keeps runtime error line:col matching the persisted script file.
 * Every export must be handled, not just the leading meta: a trailing `export function helper(){}`
 * would otherwise pass the literal walk and then throw an opaque syntax error with no location.
 */
function blankExports(ast: acorn.Program, source: string): string {
  const spans: Array<[number, number]> = []
  for (const node of ast.body) {
    if (node.type === "ExportNamedDeclaration" && node.declaration) {
      spans.push([node.start, node.declaration.start])
    } else if (node.type === "ExportDefaultDeclaration") {
      spans.push([node.start, node.declaration.start])
    } else if (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") {
      // `export { a, b }` / `export * from` — no declaration to keep, blank the whole statement.
      spans.push([node.start, node.end])
    }
  }
  if (spans.length === 0) return source

  const chars = [...source]
  for (const [start, end] of spans) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== "\n") chars[i] = " "
    }
  }
  return chars.join("")
}

export type { Meta, Phase } from "./meta.js"
export type { Diagnostic } from "./errors.js"
