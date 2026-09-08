import type * as acorn from "acorn"
import type { SourcePosition } from "./errors.js"

/** Node keys that carry position/structure metadata rather than child nodes. */
const SKIP_KEYS = new Set(["type", "loc", "range", "start", "end"])

/** Minimal AST walker — visits every node that has a `type`. */
export function walk(node: unknown, visit: (n: acorn.AnyNode) => void): void {
  if (!node || typeof node !== "object") {return}
  if (Array.isArray(node)) {
    for (const child of node) {walk(child, visit)}
    return
  }
  const record = node as Record<string, unknown>
  if (typeof record["type"] === "string") {visit(node as acorn.AnyNode)}
  for (const key of Object.keys(record)) {
    if (SKIP_KEYS.has(key)) {continue}
    walk(record[key], visit)
  }
}

/** Start position of an AST node, if the parse recorded locations. */
export function loc(node: { loc?: acorn.SourceLocation | null }): SourcePosition | undefined {
  return node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined
}
