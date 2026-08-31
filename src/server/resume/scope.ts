import { AsyncLocalStorage } from "node:async_hooks"
import { chainKey, scopeSeed } from "./key.js"
import type { AgentOptions } from "../runtime/run.js"

/**
 * Per-scope resume identity, carried on AsyncLocalStorage.
 *
 * A GLOBAL call counter cannot work here. `pipeline()` has no barrier by design — item A can be in
 * stage 3 while item B is still in stage 1 — so stage-N calls fire in model-latency order, which
 * varies run to run. A `parallel()` wider than the concurrency cap has the same problem: queued
 * thunks start in completion order. Either would make a global sequence disagree between runs, the
 * chain would diverge at the first reordered call, and a sticky break would then force the entire
 * remainder live. Resume would degrade to roughly 1/N on the shape the spec says to DEFAULT to.
 *
 * Scoping fixes that. Within one scope, calls really are sequential and source-ordered; across
 * scopes, order stops mattering because each carries its own chain.
 *
 * Verified on both Bun and Node: ALS context propagates from a host combinator, through the
 * AsyncFunction sandbox, into a user-supplied stage callback, and back into `agent()`.
 */

export type Scope = {
  /** Human-readable position, e.g. `root/L0.2/P1.0`. Recorded in the journal for debugging. */
  path: string
  /** Rolling chain key. Each agent() call in this scope advances it. */
  chain: string
  /** Next agent ordinal within this scope. */
  ordinal: number
  /** Per-scope combinator counters, so nested frames are numbered independently. */
  counters: Map<string, number>
  /**
   * Sticky, and scoped. Once a call in this scope misses the cache, every LATER call in the same
   * scope must run live: their upstream context changed, so a cached result for them belongs to a
   * different execution. Scoped rather than global so an unrelated sibling still replays.
   */
  broken: boolean
}

const storage = new AsyncLocalStorage<Scope>()

export function rootScope(seed: string): Scope {
  return { path: "root", chain: seed, ordinal: 0, counters: new Map(), broken: false }
}

export function currentScope(): Scope | undefined {
  return storage.getStore()
}

/** Runs `work` inside `scope`. */
export async function withScope<T>(scope: Scope, work: () => Promise<T>): Promise<T> {
  return await storage.run(scope, work)
}

/**
 * Opens a nested scope for one combinator item.
 *
 * `kind` is a single letter naming the combinator (L for pipeline, P for parallel, W for a nested
 * workflow), `frame` comes from {@link openFrame}, and `index` is the item or thunk position.
 */
export async function withChildScope<T>(
  kind: string,
  frame: number,
  index: number,
  work: () => Promise<T>,
): Promise<T> {
  const parent = currentScope()
  if (!parent) return await work()

  const frameLabel = `${kind}${frame}.${index}`
  const child: Scope = {
    path: `${parent.path}/${frameLabel}`,
    chain: scopeSeed(parent.chain, frameLabel),
    ordinal: 0,
    counters: new Map(),
    // A broken parent breaks its children: their surrounding context changed too.
    broken: parent.broken,
  }
  return await storage.run(child, work)
}

/**
 * Allocates a frame number for one combinator CALL.
 *
 * Called once when the combinator starts, not once per item, so every item of a single
 * `pipeline()` shares a frame number while a sibling `pipeline()` gets its own. Deriving it
 * per-item from arrival order would be fragile: it would silently depend on item 0 always being
 * scheduled first, which is true of today's combinators but is not a property worth relying on.
 */
export function openFrame(kind: string): number {
  const parent = currentScope()
  if (!parent) return 0
  const next = parent.counters.get(kind) ?? 0
  parent.counters.set(kind, next + 1)
  return next
}

export type CallIdentity = {
  key: string
  scopePath: string
  ordinal: number
  /** True when this call must run live regardless of a cache hit. */
  forceLive: boolean
}

/**
 * Advances the current scope's chain and returns the identity of one agent() call.
 *
 * MUST be called synchronously at agent() entry, before awaiting a concurrency permit. Doing it
 * after the await would make identity depend on permit-grant order, which varies with timing —
 * reintroducing exactly the nondeterminism scoping exists to remove.
 */
export function nextCallIdentity(prompt: string, options: AgentOptions, fallback: Scope): CallIdentity {
  const scope = currentScope() ?? fallback
  const ordinal = scope.ordinal
  scope.ordinal++
  scope.chain = chainKey(scope.chain, prompt, options)
  return { key: scope.chain, scopePath: scope.path, ordinal, forceLive: scope.broken }
}

/** Marks the current scope broken, so every later call in it runs live. */
export function breakScope(fallback: Scope): void {
  const scope = currentScope() ?? fallback
  scope.broken = true
}
