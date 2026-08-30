import type * as acorn from "acorn"
import { fail } from "./errors.js"
import { loc } from "./walk.js"

/**
 * Evaluates a pure-literal AST node, rejecting anything computed.
 *
 * `meta` is read statically — before the script runs — so the permission dialog and the workflow
 * list can be rendered. Nothing computable is available at that point, which is why the spec
 * requires a pure literal rather than merely a serialisable value.
 */
export function literal(node: acorn.AnyNode): unknown {
  switch (node.type) {
    case "Literal": {
      if (node.value instanceof RegExp) {
        fail({
          kind: "MetaError",
          message: "meta must be a pure literal — regular expressions are not allowed.",
          location: loc(node),
        })
      }
      return node.value
    }

    case "TemplateLiteral": {
      // Multi-line descriptions are useful; interpolation is not literal.
      if (node.expressions.length > 0) {
        const first = node.expressions[0]
        fail({
          kind: "MetaError",
          message: "meta must be a pure literal — template interpolation (${...}) is not allowed.",
          location: first ? loc(first) : loc(node),
          suggestions: ["Use a plain string, or a template literal with no ${} placeholders."],
        })
      }
      return node.quasis.map((q) => q.value.cooked ?? "").join("")
    }

    case "UnaryExpression": {
      const isNumericLiteral = node.argument.type === "Literal" && typeof node.argument.value === "number"
      if ((node.operator === "-" || node.operator === "+") && isNumericLiteral) {
        const value = (node.argument as acorn.Literal).value as number
        return node.operator === "-" ? -value : value
      }
      fail({
        kind: "MetaError",
        message: `meta must be a pure literal — found ${node.operator} expression.`,
        location: loc(node),
      })
    }

    // eslint-disable-next-line no-fallthrough -- fail() above returns never
    case "ArrayExpression": {
      return node.elements.map((el) => {
        if (el === null) return undefined
        if (el.type === "SpreadElement") {
          fail({
            kind: "MetaError",
            message: "meta must be a pure literal — spread (...) is not allowed.",
            location: loc(el),
          })
        }
        return literal(el)
      })
    }

    case "ObjectExpression": {
      const out: Record<string, unknown> = {}
      for (const prop of node.properties) {
        if (prop.type === "SpreadElement") {
          fail({
            kind: "MetaError",
            message: "meta must be a pure literal — spread (...) is not allowed.",
            location: loc(prop),
          })
        }
        if (prop.computed) {
          fail({ kind: "MetaError", message: "meta must be a pure literal — computed keys are not allowed.", location: loc(prop) })
        }
        if (prop.method) {
          fail({ kind: "MetaError", message: "meta must be a pure literal — methods are not allowed.", location: loc(prop) })
        }
        // `{ name }` is shorthand for `{ name: name }` — a VARIABLE reference, not a literal.
        if (prop.shorthand) {
          fail({
            kind: "MetaError",
            message: "meta must be a pure literal — shorthand properties reference variables.",
            location: loc(prop),
            suggestions: ["Write the value out in full, e.g. `{ name: 'my-workflow' }`."],
          })
        }
        if (prop.kind !== "init") {
          fail({
            kind: "MetaError",
            message: `meta must be a pure literal — ${prop.kind} accessors are not allowed.`,
            location: loc(prop),
          })
        }
        const key =
          prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "Literal" ? String(prop.key.value) : undefined
        if (key === undefined) {
          fail({ kind: "MetaError", message: "meta must be a pure literal — unsupported key type.", location: loc(prop.key) })
        }
        // Never let a literal reach through to Object.prototype.
        if (key === "__proto__") continue
        out[key] = literal(prop.value)
      }
      return out
    }

    default: {
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
}
