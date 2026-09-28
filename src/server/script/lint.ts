import type * as acorn from "acorn"
import { fail } from "./errors.js"
import { loc, walk } from "./walk.js"

/**
 * Identifiers a workflow script may never reference.
 *
 * Reads only — writes to undeclared names are caught by strict mode at runtime.
 */
const DENIED_GLOBALS = new Set([
  "require",
  "process",
  "globalThis",
  // Node's host global object; `global.Date.now()` would bypass every runtime trap.
  "global",
  // Bun's alias for the global object (undefined on Node, but the lint must reject both).
  "self",
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

/** The first member dereference on the `args` identifier, reported by the static lint (#78). */
export interface ArgsDereference {
  line: number
  column: number
  /** The property read, or "" for a computed access (`args[k]`) or a destructuring read. */
  property: string
  /** How the read happened, so the launch gate's message can name the shape. */
  kind: "member" | "destructure"
}

/**
 * Static determinism + Node-access lint.
 *
 * A lint beats a runtime throw because it reports line:col before anything executes. The runtime
 * traps in the sandbox remain as a backstop for dynamically-reached forms like `Date[k]()`.
 *
 * The bans are a determinism requirement, not arbitrary restriction: resume replays the script and
 * matches agent() calls against cached results, which only works if the script is a pure function
 * of (source, args).
 *
 * Returns the FIRST member dereference on the `args` identifier, when the script contains one
 * (#78). This is a flag, not a failure: dereferencing `args` is legal when args IS an object.
 * The sandbox launch gate combines the flag with the runtime args value and throws at script
 * start when they disagree — naming the received type and a preview instead of letting
 * `undefined` flow silently into every agent prompt.
 */
export function lintDeterminism(ast: acorn.Program): ArgsDereference | undefined {
  let argsDereference: ArgsDereference | undefined
  // Aliases bound directly to args (`const a = args`, #139): member reads through the alias
  // poison prompts the same way a direct read does. One-hop only — alias-of-alias, reads that
  // precede the binding in source order, and re-binding after the initial alias stay unflagged;
  // same syntactic-limit class as the shadowing note below.
  const argsAliases = new Set<string>()
  walk(ast, (node) => {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression") {
      fail({
        kind: "DeterminismError",
        message: "Workflow scripts cannot import modules.",
        location: loc(node),
        suggestions: [
          "Everything a workflow needs is already injected: agent, parallel, pipeline, phase, log, args, budget, workflow.",
        ],
      })
    }

    // `x.constructor.constructor` is the classic route to the real Function constructor, which
    // reaches the host realm and with it an untrapped Date.now — silently defeating resume.
    // Blocking the literal form stops accidental and obvious deliberate use; a computed form
    // (`x["const"+"ructor"]`) still gets through, which is documented in sandbox.ts.
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === "constructor") {
      fail({
        kind: "DeterminismError",
        message: "Accessing `.constructor` is not allowed in workflow scripts.",
        location: loc(node),
        suggestions: [
          "It reaches the host realm and an untrapped Date.now(), which breaks resume.",
          "If you need a class check, compare a discriminant field instead.",
        ],
      })
    }

    if (node.type === "MemberExpression" && !node.computed && node.object.type === "Identifier") {
      const property = node.property.type === "Identifier" ? node.property.name : "",
       target = `${node.object.name}.${property}`
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

    // `args.X`, `args["X"]` and `args?.X` all dereference the args global — every form poisons
    // prompts with `undefined` when args is not an object. The flag carries the first read so
    // the runtime gate can point at it; computed accesses report an empty property.
    //
    // KNOWN LIMIT — the flag is syntactic, like the Date/Math bans: a nested function or catch
    // parameter NAMED `args` (or an alias name, #139) is falsely flagged, and no scope tracking
    // exists to tell it from the global. The gate message points at the read, so the fix is a
    // rename; the Date.now ban has the same shape of limit.
    if (argsDereference === undefined && node.type === "MemberExpression" && node.object.type === "Identifier" && (node.object.name === "args" || argsAliases.has(node.object.name))) {
      const position = loc(node)
      if (position !== undefined) {
        // A computed access cannot name its property statically; the gate renders it as `args[…]`.
        let property = ""
        if (!node.computed && node.property.type === "Identifier") {property = node.property.name}
        argsDereference = { ...position, property, kind: "member" }
      }
    }

    // Alias binding: a plain identifier initialized to the args global (#139). Recorded BEFORE
    // the member checks above in walk order — source order guarantees a legal binding precedes
    // its reads, so the set is populated by the time an aliased read is visited.
    if (node.type === "VariableDeclarator" && node.init?.type === "Identifier" && node.init.name === "args" && node.id.type === "Identifier") {
      argsAliases.add(node.id.name)
    }

    // Destructuring reads (`const { repo } = args`, `for (const x of args)`) poison prompts the
    // same way a member dereference does and produce no MemberExpression to flag — cover them.
    if (argsDereference === undefined) {
      let destructured = false
      if (node.type === "VariableDeclarator" && node.init?.type === "Identifier" && node.init.name === "args" && (node.id.type === "ObjectPattern" || node.id.type === "ArrayPattern")) {
        destructured = true
      } else if ((node.type === "ForOfStatement" || node.type === "ForInStatement") && node.right.type === "Identifier" && node.right.name === "args") {
        destructured = true
      } else if (node.type === "AssignmentExpression" && node.operator === "=" && node.right.type === "Identifier" && node.right.name === "args" && (node.left.type === "ObjectPattern" || node.left.type === "ArrayPattern")) {
        destructured = true
      }
      if (destructured) {
        const position = loc(node)
        if (position !== undefined) {argsDereference = { ...position, property: "", kind: "destructure" }}
      }
    }

    if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "Date" &&
      node.arguments.length === 0
    ) {
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
  return argsDereference
}
