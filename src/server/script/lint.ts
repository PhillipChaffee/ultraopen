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

/**
 * Static determinism + Node-access lint.
 *
 * A lint beats a runtime throw because it reports line:col before anything executes. The runtime
 * traps in the sandbox remain as a backstop for dynamically-reached forms like `Date[k]()`.
 *
 * The bans are a determinism requirement, not arbitrary restriction: resume replays the script and
 * matches agent() calls against cached results, which only works if the script is a pure function
 * of (source, args).
 */
export function lintDeterminism(ast: acorn.Program): void {
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
}
