import * as acorn from "acorn"
import { fail, type Diagnostic } from "./errors.js"
import { MAX_SCRIPT_CHARS } from "./limits.js"

export type Meta = {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string; model?: string }>
}

export type ParsedScript = {
  meta: Meta
  /** Source with every `export ` keyword blanked in place. Byte offsets are preserved. */
  body: string
  ast: acorn.Program
}

/** Identifiers a workflow script may never reference. Reads only — writes are caught by strict mode. */
const DENIED_GLOBALS = new Set([
  "require",
  "process",
  "globalThis",
  "eval",
  "Function",
  "Bun",
  "__dirname",
  "__filename",
  "fetch",
  "Buffer",
  "WebAssembly",
  "XMLHttpRequest",
  "importScripts",
])

const loc = (node: { loc?: acorn.SourceLocation | null }) =>
  node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined

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
  } catch (err) {
    const e = err as Error & { loc?: { line: number; column: number } }
    fail({
      kind: "ParseError",
      message: `Workflow scripts are plain JavaScript, not TypeScript. ${e.message}`,
      location: e.loc ? { line: e.loc.line, column: e.loc.column } : undefined,
      suggestions: [
        "Remove type annotations (`: string[]`), interfaces, and generics — they are not valid JavaScript.",
        "The script body runs in an async context, so top-level `await` is fine.",
      ],
    })
  }

  const meta = extractMeta(ast, source)
  lintDeterminism(ast)

  return { meta, body: blankExports(ast, source), ast }
}

/**
 * Extracts `export const meta = {...}` statically, without executing anything.
 *
 * The spec requires meta to be a PURE LITERAL precisely because it is read before the script runs.
 */
function extractMeta(ast: acorn.Program, source: string): Meta {
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
  if (decl.id.type !== "Identifier" || decl.id.name !== "meta") {
    fail({
      kind: "MetaError",
      message: "The first statement must declare `meta`, not another name.",
      location: loc(decl),
    })
  }
  if (!decl.init) {
    fail({ kind: "MetaError", message: "`meta` must be initialised with an object literal.", location: loc(decl) })
  }

  const value = literal(decl.init, source)
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail({ kind: "MetaError", message: "`meta` must be an object literal.", location: loc(decl.init) })
  }

  const m = value as Record<string, unknown>
  const need = (key: string) => {
    const v = m[key]
    if (typeof v !== "string" || v.trim() === "") {
      fail({
        kind: "MetaError",
        message: `meta.${key} is required and must be a non-empty string.`,
        location: loc(decl.init!),
      })
    }
    return v
  }

  const meta: Meta = { name: need("name"), description: need("description") }

  if (m.whenToUse !== undefined) {
    if (typeof m.whenToUse !== "string") {
      fail({ kind: "MetaError", message: "meta.whenToUse must be a string.", location: loc(decl.init!) })
    }
    meta.whenToUse = m.whenToUse
  }

  if (m.phases !== undefined) {
    if (!Array.isArray(m.phases)) {
      fail({ kind: "MetaError", message: "meta.phases must be an array.", location: loc(decl.init!) })
    }
    meta.phases = m.phases.map((p, i) => {
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        fail({ kind: "MetaError", message: `meta.phases[${i}] must be an object.`, location: loc(decl.init!) })
      }
      const phase = p as Record<string, unknown>
      if (typeof phase.title !== "string" || phase.title.trim() === "") {
        fail({
          kind: "MetaError",
          message: `meta.phases[${i}].title is required and must be a non-empty string.`,
          location: loc(decl.init!),
        })
      }
      for (const k of ["detail", "model"]) {
        if (phase[k] !== undefined && typeof phase[k] !== "string") {
          fail({ kind: "MetaError", message: `meta.phases[${i}].${k} must be a string.`, location: loc(decl.init!) })
        }
      }
      // NOTE: phases[].model is DISPLAY-ONLY metadata, matching Claude Code. It does not override
      // the model for that phase. Wiring it as a real override would silently change semantics for
      // every ported script that annotates a phase.
      return {
        title: phase.title,
        ...(phase.detail !== undefined ? { detail: phase.detail as string } : {}),
        ...(phase.model !== undefined ? { model: phase.model as string } : {}),
      }
    })
  }

  return meta
}

/** Evaluates a pure-literal AST node, rejecting anything computed. */
function literal(node: acorn.AnyNode, source: string): unknown {
  switch (node.type) {
    case "Literal":
      if (node.value instanceof RegExp) {
        fail({ kind: "MetaError", message: "meta must be a pure literal — regular expressions are not allowed.", location: loc(node) })
      }
      return node.value

    case "TemplateLiteral":
      // Multi-line descriptions are useful; interpolation is not literal.
      if (node.expressions.length > 0) {
        fail({
          kind: "MetaError",
          message: "meta must be a pure literal — template interpolation (${...}) is not allowed.",
          location: loc(node.expressions[0]),
          suggestions: ["Use a plain string, or a template literal with no ${} placeholders."],
        })
      }
      return node.quasis.map((q) => q.value.cooked ?? "").join("")

    case "UnaryExpression":
      if ((node.operator === "-" || node.operator === "+") && node.argument.type === "Literal" && typeof node.argument.value === "number") {
        return node.operator === "-" ? -node.argument.value : node.argument.value
      }
      fail({ kind: "MetaError", message: `meta must be a pure literal — found ${node.operator} expression.`, location: loc(node) })
      break

    case "ArrayExpression":
      return node.elements.map((el) => {
        if (el === null) return undefined
        if (el.type === "SpreadElement") {
          fail({ kind: "MetaError", message: "meta must be a pure literal — spread (...) is not allowed.", location: loc(el) })
        }
        return literal(el as acorn.AnyNode, source)
      })

    case "ObjectExpression": {
      const out: Record<string, unknown> = {}
      for (const prop of node.properties) {
        if (prop.type === "SpreadElement") {
          fail({ kind: "MetaError", message: "meta must be a pure literal — spread (...) is not allowed.", location: loc(prop) })
        }
        const p = prop as acorn.Property
        if (p.computed) {
          fail({ kind: "MetaError", message: "meta must be a pure literal — computed keys are not allowed.", location: loc(p) })
        }
        if (p.method) {
          fail({ kind: "MetaError", message: "meta must be a pure literal — methods are not allowed.", location: loc(p) })
        }
        // `{ name }` is shorthand for `{ name: name }` — a VARIABLE reference, not a literal.
        if (p.shorthand) {
          fail({
            kind: "MetaError",
            message: "meta must be a pure literal — shorthand properties reference variables.",
            location: loc(p),
            suggestions: ["Write the value out in full, e.g. `{ name: 'my-workflow' }`."],
          })
        }
        if (p.kind !== "init") {
          fail({ kind: "MetaError", message: `meta must be a pure literal — ${p.kind} accessors are not allowed.`, location: loc(p) })
        }
        const key = p.key.type === "Identifier" ? p.key.name : p.key.type === "Literal" ? String(p.key.value) : undefined
        if (key === undefined) {
          fail({ kind: "MetaError", message: "meta must be a pure literal — unsupported key type.", location: loc(p.key) })
        }
        if (key === "__proto__") continue
        out[key] = literal(p.value as acorn.AnyNode, source)
      }
      return out
    }

    default:
      fail({
        kind: "MetaError",
        message: `meta must be a pure literal — found ${node.type}.`,
        location: loc(node),
        suggestions: [
          "meta is read statically, before the script runs, so it cannot reference variables or call functions.",
          "Move any computed values into the script body below meta.",
        ],
      })
  }
}

/**
 * Static determinism + Node-access lint.
 *
 * A lint beats a runtime throw because it reports line:col before anything executes. The runtime
 * traps in the sandbox remain as a backstop for dynamic access.
 */
function lintDeterminism(ast: acorn.Program): void {
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
      fail({
        kind: "DeterminismError",
        message: "Workflow scripts cannot import modules.",
        location: loc(node),
        suggestions: ["Everything a workflow needs is already injected: agent, parallel, pipeline, phase, log, args, budget, workflow."],
      })
    }

    if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier") {
      const target = `${node.object.name}.${node.property.type === "Identifier" ? node.property.name : ""}`
      if (target === "Date.now") {
        fail({
          kind: "DeterminismError",
          message: "Date.now() is unavailable in workflow scripts (it breaks resume).",
          location: loc(node),
          suggestions: ["Stamp results after the workflow returns, or pass timestamps in via `args`."],
        })
      }
      if (target === "Math.random") {
        fail({
          kind: "DeterminismError",
          message: "Math.random() is unavailable in workflow scripts (it breaks resume).",
          location: loc(node),
          suggestions: ["Vary behaviour by index instead — include the index in the agent label or prompt."],
        })
      }
    }

    if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Date" && node.arguments.length === 0) {
      fail({
        kind: "DeterminismError",
        message: "`new Date()` with no arguments is unavailable in workflow scripts (it breaks resume).",
        location: loc(node),
        suggestions: ["Pass a timestamp via `args` and use `new Date(args.now)`."],
      })
    }

    if (node.type === "Identifier" && DENIED_GLOBALS.has(node.name)) {
      fail({
        kind: "DeterminismError",
        message: `\`${node.name}\` is not available in workflow scripts.`,
        location: loc(node),
        suggestions: ["Workflow scripts have no filesystem or Node API access — delegate that work to an agent()."],
      })
    }
  })
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
    for (let i = start; i < end; i++) if (chars[i] !== "\n") chars[i] = " "
  }
  return chars.join("")
}

/** Minimal AST walker — visits every node with a `type`. */
function walk(node: unknown, visit: (n: acorn.AnyNode) => void): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  const n = node as Record<string, unknown>
  if (typeof n.type === "string") visit(node as acorn.AnyNode)
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") continue
    walk(n[key], visit)
  }
}

export type { Diagnostic }
