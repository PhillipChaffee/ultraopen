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

/** Node keys that carry position/structure metadata rather than child nodes. */
const SKIP_KEYS = new Set(["type", "loc", "range", "start", "end"])

/** Names the launch injects as function parameters (SandboxGlobals) — always resolvable. */
const PROVIDED_GLOBALS = new Set(["agent", "parallel", "pipeline", "phase", "log", "args", "budget", "workflow", "arguments"])

/** Collects the names a binding pattern declares, into the given set. */
const collectPatternNames = (pattern: unknown, into: Set<string>): void => {
  if (!pattern || typeof pattern !== "object" || !("type" in pattern)) {return}
  const node = pattern as acorn.AnyNode
  switch (node.type) {
    case "Identifier": {into.add((node as acorn.Identifier).name); break}
    case "ObjectPattern": {
      for (const prop of (node as acorn.ObjectPattern).properties) {
        if (prop.type === "Property") {collectPatternNames((prop as acorn.Property).value, into)}
        else {collectPatternNames((prop as acorn.RestElement).argument, into)}
      }
      break
    }
    case "ArrayPattern": {for (const el of (node as acorn.ArrayPattern).elements) {collectPatternNames(el, into)}; break}
    case "AssignmentPattern": {collectPatternNames((node as acorn.AssignmentPattern).left, into); break}
    case "RestElement": {collectPatternNames((node as acorn.RestElement).argument, into); break}
  }
}

/**
 * var is function-scoped and hoisted: collect every var name in the subtree, without descending
 * into nested functions (their vars are their own scope).
 */
const hoistVarNames = (input: unknown, into: Set<string>): void => {
  if (!input || typeof input !== "object") {return}
  if (Array.isArray(input)) {for (const child of input) {hoistVarNames(child, into)}; return}
  if (!("type" in input)) {return}
  const node = input as acorn.AnyNode
  switch (node.type) {
    case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": case "ClassDeclaration": case "ClassExpression": {return}
    case "VariableDeclaration": {
      const declaration = node as acorn.VariableDeclaration
      if (declaration.kind === "var") {for (const d of declaration.declarations) {collectPatternNames(d.id, into)}}
      for (const d of declaration.declarations) {hoistVarNames(d.init, into)}
      return
    }
    default: {
      const record = node as unknown as Record<string, unknown>
      for (const key of Object.keys(record)) {
        if (SKIP_KEYS.has(key)) {continue}
        hoistVarNames(record[key], into)
      }
    }
  }
}

/**
 * Block-entry pre-registration: let/const/class/function declarations at the immediate level of
 * a block register before its statements are walked, so hoisted-function use and any declaration
 * order pass. (TDZ violations pass too — a documented limit, not a bug.)
 */
const registerBlockDeclarations = (statements: unknown[], into: Set<string>): void => {
  for (const statement of statements) {
    if (!statement || typeof statement !== "object" || !("type" in statement)) {continue}
    let node = statement as acorn.AnyNode
    if (node.type === "ExportNamedDeclaration" && (node as acorn.ExportNamedDeclaration).declaration) {
      node = (node as acorn.ExportNamedDeclaration).declaration as acorn.AnyNode
    }
    if (node.type === "VariableDeclaration" && (node as acorn.VariableDeclaration).kind !== "var") {
      for (const d of (node as acorn.VariableDeclaration).declarations) {collectPatternNames(d.id, into)}
    } else if (node.type === "FunctionDeclaration") {
      const id = (node as acorn.FunctionDeclaration).id
      if (id) {into.add(id.name)}
    } else if (node.type === "ClassDeclaration") {
      const id = (node as acorn.ClassDeclaration).id
      if (id) {into.add(id.name)}
    }
  }
}

/**
 * Static undefined-identifier refusal (#144).
 *
 * A script that reads a name it never declared dies at first reference — mid-run, after the
 * approval and often after spend. This pass walks with a scope stack and refuses the FIRST read
 * that resolves nowhere: not a declaration in scope, not a provided global, and not on the host
 * globalThis. The sandbox compiles with `new AsyncFunction` into the HOST realm, so
 * `name in globalThis` here is exactly the resolution the running body will get — standard
 * intrinsics and host-provided names pass without an enumerated list, and the check is
 * self-consistent per runtime (bun vs node parity: each environment judges its own globals).
 *
 * Lenient by design — a false refusal blocks a legal script, a false negative just leaves the
 * runtime ReferenceError where it is today. KNOWN LIMITS, each documented rather than solved:
 * TDZ use-before-let/const passes (declarations pre-register at scope entry); writes to
 * undeclared names (`x = 1`, `x++`) pass (strict mode catches them at runtime); `typeof x`
 * guards pass; unknown node types descend generically; alias-of-alias chains and dynamic
 * construction (`globalThis[name]`) are invisible to a static pass.
 */
export function lintUndefinedIdentifiers(ast: acorn.Program): void {
  interface Scope { names: Set<string> }

  const resolves = (name: string, scopes: Scope[]): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i]
      if (scope && scope.names.has(name)) {return true}
    }
    if (PROVIDED_GLOBALS.has(name)) {return true}
    return typeof globalThis === "object" && globalThis !== null && name in globalThis
  }

  const visit = (input: unknown, scopes: Scope[]): void => {
    if (!input || typeof input !== "object" || !("type" in input)) {return}
    const node = input as acorn.AnyNode
    switch (node.type) {
      case "Identifier": {
        if (!resolves(node.name, scopes)) {
          const position = loc(node)
          fail({
            kind: "RuntimeError",
            message:
              `\`${node.name}\` is not defined — the script reads it${ 
              position ? ` (first at line ${position.line}:${position.column})` : "" 
              }, but nothing declares it, no launch global provides it, and the host realm has no such name.`,
            location: position,
            suggestions: [
              `Declare it before use: \`const ${node.name} = ...\`.`,
              "If the value comes from outside the script, pass it in via the `args` object.",
            ],
          })
        }
        return
      }
      case "Program": {
        const scope: Scope = { names: new Set() }
        hoistVarNames(node.body, scope.names)
        registerBlockDeclarations(node.body, scope.names)
        scopes.push(scope)
        for (const statement of node.body) {visit(statement, scopes)}
        scopes.pop()
        return
      }
      case "BlockStatement": {
        const scope: Scope = { names: new Set() }
        registerBlockDeclarations(node.body, scope.names)
        scopes.push(scope)
        for (const statement of node.body) {visit(statement, scopes)}
        scopes.pop()
        return
      }
      case "FunctionDeclaration": case "FunctionExpression": case "ArrowFunctionExpression": {
        const scope: Scope = { names: new Set() }
        if (node.type === "FunctionExpression" && node.id) {scope.names.add(node.id.name)}
        for (const param of node.params) {collectPatternNames(param, scope.names)}
        hoistVarNames(node.body, scope.names)
        scopes.push(scope)
        for (const param of node.params) {visit(param, scopes)}
        visit(node.body, scopes)
        scopes.pop()
        return
      }
      case "ForStatement": {
        const scope: Scope = { names: new Set() }
        if (node.init && node.init.type === "VariableDeclaration") {
          for (const d of node.init.declarations) {collectPatternNames(d.id, scope.names)}
        }
        scopes.push(scope)
        visit(node.init, scopes)
        visit(node.test, scopes)
        visit(node.update, scopes)
        visit(node.body, scopes)
        scopes.pop()
        return
      }
      case "ForInStatement": case "ForOfStatement": {
        const scope: Scope = { names: new Set() }
        if (node.left.type === "VariableDeclaration") {
          for (const d of node.left.declarations) {collectPatternNames(d.id, scope.names)}
        }
        scopes.push(scope)
        visit(node.left, scopes)
        visit(node.right, scopes)
        visit(node.body, scopes)
        scopes.pop()
        return
      }
      case "SwitchStatement": {
        const scope: Scope = { names: new Set() }
        for (const c of node.cases) {registerBlockDeclarations(c.consequent, scope.names)}
        scopes.push(scope)
        visit(node.discriminant, scopes)
        for (const c of node.cases) {
          visit(c.test, scopes)
          for (const statement of c.consequent) {visit(statement, scopes)}
        }
        scopes.pop()
        return
      }
      case "CatchClause": {
        const scope: Scope = { names: new Set() }
        if (node.param) {collectPatternNames(node.param, scope.names)}
        scopes.push(scope)
        visit(node.body, scopes)
        scopes.pop()
        return
      }
      case "ClassDeclaration": case "ClassExpression": {
        const scope: Scope = { names: new Set() }
        if (node.type === "ClassExpression" && node.id) {scope.names.add(node.id.name)}
        scopes.push(scope)
        visit(node.superClass, scopes)
        visit(node.body, scopes)
        scopes.pop()
        return
      }
      case "MemberExpression": {
        visit(node.object, scopes)
        if (node.computed) {visit(node.property, scopes)}
        return
      }
      case "Property": {
        // `{ a: expr }` — the key is a name, not a read. `{ a }` shorthand — the value IS the
        // read. Computed keys are expressions.
        if (node.computed) {visit(node.key, scopes)}
        if (!node.shorthand) {visit(node.value, scopes)}
        return
      }
      case "PropertyDefinition": case "MethodDefinition": {
        if (node.computed) {visit(node.key, scopes)}
        visit(node.value, scopes)
        return
      }
      case "AssignmentExpression": {
        // Writes are not reads: an Identifier or pattern on the left declares leniently (strict
        // mode catches illegal writes at runtime), but a member path's BASE is read.
        if (node.left.type === "MemberExpression") {
          visit(node.left.object, scopes)
          if (node.left.computed) {visit(node.left.property, scopes)}
        } else if (node.left.type === "Identifier") {
          const inner = scopes.at(-1)
          if (inner) {inner.names.add(node.left.name)}
        } else {
          const inner = scopes.at(-1)
          if (inner) {collectPatternNames(node.left, inner.names)}
        }
        visit(node.right, scopes)
        break
      }
      case "UpdateExpression": {return}
      case "UnaryExpression": {
        // `typeof x` is the classic guard: the probe itself is not a read, AND a name probed
        // this way is guarded at runtime — later reads of it only happen when it exists. The
        // pass registers the probed name leniently (a false negative here is the safe direction).
        const inner = scopes.at(-1)
        if (node.operator === "typeof" && node.argument.type === "Identifier" && inner) {
          inner.names.add(node.argument.name)
          return
        }
        visit(node.argument, scopes)
        return
      }
      case "LabeledStatement": {visit(node.body, scopes); break}
      case "BreakStatement": case "ContinueStatement": case "ThisExpression": case "Super": case "MetaProperty": case "PrivateIdentifier": {return}
      case "VariableDeclaration": {
        for (const d of node.declarations) {visit(d.init, scopes)}
        return
      }
      case "VariableDeclarator": {
        // Reached directly only outside the guarded cases: init is a read; the id is a binding.
        visit(node.init, scopes)
        break
      }
      case "ObjectPattern": case "ArrayPattern": case "AssignmentPattern": case "RestElement": case "ImportDeclaration": case "ExportAllDeclaration": {break}
      case "ExportNamedDeclaration": {
        visit(node.declaration, scopes)
        return
      }
      case "StaticBlock": {
        const scope: Scope = { names: new Set() }
        scopes.push(scope)
        for (const statement of node.body) {visit(statement, scopes)}
        scopes.pop()
        return
      }
      default: {
        // Unknown node type: descend generically — every child that carries a `type` gets
        // visited as its own node, so Identifier reads inside still resolve through the rules.
        const record = node as unknown as Record<string, unknown>
        for (const key of Object.keys(record)) {
          if (SKIP_KEYS.has(key)) {continue}
          const child = record[key]
          if (Array.isArray(child)) {for (const c of child) {visit(c, scopes)}}
          else if (child && typeof child === "object" && typeof (child as Record<string, unknown>)["type"] === "string") {visit(child, scopes)}
        }
      }
    }
  }

  visit(ast, [])
}
