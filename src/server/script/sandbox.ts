import { WorkflowScriptError } from "./errors.js"

/**
 * Executes a workflow script body with injected host functions and shadowed globals.
 *
 * Why AsyncFunction and not node:vm:
 *   - `vm.compileFunction` cannot produce an async function, so the spec's mandatory top-level
 *     `await` is impossible; `vm.SourceTextModule` is undefined on stock Node but a function
 *     under Bun, an asymmetry a plugin cannot control.
 *   - Host functions must accept CLOSURES — `parallel(thunks)` takes `() => Promise` and
 *     `pipeline(items, ...stages)` takes stage callbacks. A realm boundary makes those either
 *     unrepresentable or require cross-realm adoption shims.
 *   - An AsyncFunction body has no access to the plugin's module scope (unlike `eval`), and its
 *     parameters lexically shadow real globals. That is the right isolation level here: the
 *     threat model is determinism, not confinement — the authoring model already holds bash.
 */

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

const determinism = (message: string, suggestion: string) =>
  new WorkflowScriptError({ kind: "DeterminismError", message, suggestions: [suggestion] })

/**
 * A Date whose 0-arg construction and `.now()` throw, but which otherwise behaves normally.
 * `new Date(iso)`, instance methods, Date.parse and Date.UTC all still work.
 */
function guardedDate(): DateConstructor {
  const handler: ProxyHandler<DateConstructor> = {
    construct(target, argsList, newTarget) {
      if (argsList.length === 0) {
        throw determinism(
          "`new Date()` with no arguments is unavailable in workflow scripts (it breaks resume).",
          "Pass a timestamp via `args` and use `new Date(args.now)`.",
        )
      }
      return Reflect.construct(target, argsList, newTarget)
    },
    get(target, prop, receiver) {
      if (prop === "now") {
        return () => {
          throw determinism(
            "Date.now() is unavailable in workflow scripts (it breaks resume).",
            "Stamp results after the workflow returns, or pass timestamps in via `args`.",
          )
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  }
  return new Proxy(Date, handler)
}

/** Math with a throwing `random`. Prototype chain keeps every other method intact. */
function guardedMath(): Math {
  const proxy = Object.create(Math) as Math
  Object.defineProperty(proxy, "random", {
    get() {
      return () => {
        throw determinism(
          "Math.random() is unavailable in workflow scripts (it breaks resume).",
          "Vary behaviour by index instead — include the index in the agent label or prompt.",
        )
      }
    },
    configurable: true,
  })
  return proxy
}

function denied(name: string): () => never {
  return () => {
    throw new WorkflowScriptError({
      kind: "DeterminismError",
      message: `\`${name}\` is not available in workflow scripts.`,
      suggestions: ["Workflow scripts have no filesystem or Node API access — delegate that work to an agent()."],
    })
  }
}

export type SandboxGlobals = {
  agent: unknown
  parallel: unknown
  pipeline: unknown
  phase: unknown
  log: unknown
  args: unknown
  budget: unknown
  workflow: unknown
}

/**
 * Compiles and runs a workflow body. Returns whatever the script returns.
 *
 * `"use strict"` is prepended with NO trailing newline so every reported line number still matches
 * the persisted script. Strict mode matters: an AsyncFunction body is sloppy by default, so an
 * undeclared `leaked = 42` would write to the real host globalThis — invisible to the static lint,
 * which only catches reads.
 */
export async function run(body: string, globals: SandboxGlobals): Promise<unknown> {
  // One map, so names and values cannot drift out of alignment.
  //
  // NOTE: `eval` is deliberately absent. Strict mode forbids it as a binding name ("Invalid
  // parameters or function name in strict mode"), so it cannot be shadowed here. It is covered
  // by the static deny walk plus the `globalThis: undefined` shadow, which closes the
  // `globalThis["ev"+"al"]` dynamic path.
  const bindings: Record<string, unknown> = {
    agent: globals.agent,
    parallel: globals.parallel,
    pipeline: globals.pipeline,
    phase: globals.phase,
    log: globals.log,
    args: globals.args,
    budget: globals.budget,
    workflow: globals.workflow,
    // Shadowed globals. Parameters win over real globals inside the body.
    Date: guardedDate(),
    Math: guardedMath(),
    require: denied("require"),
    process: undefined,
    globalThis: undefined,
    fetch: denied("fetch"),
    Bun: undefined,
    Function: denied("Function"),
    importScripts: denied("importScripts"),
    __dirname: undefined,
    __filename: undefined,
  }

  const names = Object.keys(bindings)
  const values = names.map((n) => bindings[n])

  let compiled: (...a: unknown[]) => Promise<unknown>
  try {
    compiled = new AsyncFunction(...names, `"use strict";${body}`)
  } catch (err) {
    throw new WorkflowScriptError({
      kind: "ParseError",
      message: `Workflow script failed to compile: ${(err as Error).message}`,
      suggestions: ["Workflow scripts are plain JavaScript, not TypeScript."],
    })
  }

  return compiled(...values)
}
