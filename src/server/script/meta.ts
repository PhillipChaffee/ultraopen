import type * as acorn from "acorn"
import { fail, type SourcePosition } from "./errors.js"
import { literal } from "./literal.js"
import { loc } from "./walk.js"

export type Phase = {
  title: string
  /** Display-only detail shown in the progress UI. */
  detail?: string
  /**
   * Display-only, matching Claude Code. This does NOT override the model for the phase — wiring
   * it as a real override would silently change semantics for every ported script that annotates
   * a phase with the model it happens to use.
   */
  model?: string
}

export type Meta = {
  name: string
  description: string
  whenToUse?: string
  phases?: Phase[]
}

/**
 * Extracts `export const meta = {...}` statically, without executing anything.
 *
 * The spec requires meta to be the FIRST statement and a PURE LITERAL, precisely because it is
 * read before the script runs.
 */
export function extractMeta(ast: acorn.Program): Meta {
  const first = ast.body[0]
  if (
    !first ||
    first.type !== "ExportNamedDeclaration" ||
    !first.declaration ||
    first.declaration.type !== "VariableDeclaration" ||
    first.declaration.kind !== "const" ||
    first.declaration.declarations.length !== 1
  ) {
    fail({
      kind: "MetaError",
      message: "A workflow script must begin with `export const meta = { ... }`.",
      location: first ? loc(first) : { line: 1, column: 0 },
      suggestions: ["Example: export const meta = { name: 'my-workflow', description: 'What it does' }"],
    })
  }

  const decl = first.declaration.declarations[0]
  if (!decl) {
    fail({ kind: "MetaError", message: "`meta` must be initialised with an object literal.", location: loc(first) })
  }
  if (decl.id.type !== "Identifier" || decl.id.name !== "meta") {
    fail({ kind: "MetaError", message: "The first statement must declare `meta`, not another name.", location: loc(decl) })
  }
  const init = decl.init
  if (!init) {
    fail({ kind: "MetaError", message: "`meta` must be initialised with an object literal.", location: loc(decl) })
  }

  const at = loc(init)
  const value = literal(init)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail({ kind: "MetaError", message: "`meta` must be an object literal.", location: at })
  }

  const raw = value as Record<string, unknown>
  const meta: Meta = {
    name: requireString(raw, "name", at),
    description: requireString(raw, "description", at),
  }

  const whenToUse = raw["whenToUse"]
  if (whenToUse !== undefined) {
    if (typeof whenToUse !== "string") {
      fail({ kind: "MetaError", message: "meta.whenToUse must be a string.", location: at })
    }
    meta.whenToUse = whenToUse
  }

  const phases = raw["phases"]
  if (phases !== undefined) {
    if (!Array.isArray(phases)) {
      fail({ kind: "MetaError", message: "meta.phases must be an array.", location: at })
    }
    meta.phases = phases.map((entry: unknown, i: number) => parsePhase(entry, i, at))
  }

  return meta
}

function requireString(raw: Record<string, unknown>, key: string, at: SourcePosition | undefined): string {
  const value = raw[key]
  if (typeof value !== "string" || value.trim() === "") {
    fail({ kind: "MetaError", message: `meta.${key} is required and must be a non-empty string.`, location: at })
  }
  return value
}

function parsePhase(entry: unknown, index: number, at: SourcePosition | undefined): Phase {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    fail({ kind: "MetaError", message: `meta.phases[${index}] must be an object.`, location: at })
  }

  const raw = entry as Record<string, unknown>
  const title = raw["title"]
  if (typeof title !== "string" || title.trim() === "") {
    fail({
      kind: "MetaError",
      message: `meta.phases[${index}].title is required and must be a non-empty string.`,
      location: at,
    })
  }

  const phase: Phase = { title }
  for (const key of ["detail", "model"] as const) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== "string") {
      fail({ kind: "MetaError", message: `meta.phases[${index}].${key} must be a string.`, location: at })
    }
    phase[key] = value
  }
  return phase
}
