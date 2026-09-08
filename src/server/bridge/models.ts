import { makeEffortResolver } from "./effort.js"
import type { ModelVariants } from "./effort.js"

/**
 * Reads the live provider catalog so effort can be resolved against a model's REAL variants.
 *
 * This has to be fetched rather than assumed: variant sets differ per model family (Claude 5
 * offers low/medium/high/xhigh/max, 4.6-class models have no xhigh, and many models have none at
 * all), and asking for one a model does not have is a silent no-op.
 */

export interface ProviderCatalog {
  providers?: {
    id?: string
    models?: Record<string, { variants?: Record<string, unknown> } | undefined>
  }[]
}

export interface CatalogClient {
  config?: {
    providers: () => Promise<{ data?: ProviderCatalog; error?: unknown }>
  }
}

export interface ModelRef { providerID: string; modelID: string }

/**
 * Splits a "provider/model" string.
 *
 * Model ids can themselves contain slashes (e.g. `together/Qwen/Qwen3.5`), so only the FIRST
 * segment is the provider.
 */
export function parseModelRef(model: string | undefined): ModelRef | undefined {
  if (!model || !model.includes("/")) {return undefined}
  const separator = model.indexOf("/"),
   providerID = model.slice(0, separator),
   modelID = model.slice(separator + 1)
  if (providerID === "" || modelID === "") {return undefined}
  return { providerID, modelID }
}

/** Looks up the variant ids a model actually supports. */
export function variantsOf(catalog: ProviderCatalog | undefined, ref: ModelRef | undefined): ModelVariants {
  if (!catalog || !ref) {return { available: [] }}
  const provider = catalog.providers?.find((entry) => entry.id === ref.providerID),
   model = provider?.models?.[ref.modelID],
   variants = model?.variants
  return {
    available: variants ? Object.keys(variants) : [],
    modelLabel: `${ref.providerID}/${ref.modelID}`,
  }
}

export interface ResolverBundle {
  resolveModel: (model: string | undefined) => ModelRef | undefined
  /**
   * Resolves effort against the model the call will ACTUALLY use.
   *
   * The model ref must be passed in: variants belong to a model, and an `agent()` call may pin one
   * that differs from the run default. Resolving against the default instead would send a variant
   * the chosen model may not support — the exact silent no-op this whole path exists to prevent.
   */
  resolveVariant: (effort: string | undefined, model?: ModelRef | undefined) => string | undefined
}

/**
 * Builds the model and effort resolvers for one run.
 *
 * Fetched ONCE per run rather than per agent: the catalog does not change mid-run, and a fetch per
 * agent would add a round trip to every spawn. A catalog fetch that fails degrades to "no variants
 * known", which reports every effort request as an unhonoured downgrade rather than sending a
 * variant that may not exist.
 */
export async function makeResolvers(
  client: CatalogClient,
  options: { defaultModel?: string | undefined; onNote?: ((note: string) => void) | undefined },
): Promise<ResolverBundle> {
  let catalog: ProviderCatalog | undefined
  try {
    catalog = await client.config?.providers().then((response) => response.data)
  } catch {
    // Non-fatal: the run proceeds with the parent's inherited model and no variant.
    options.onNote?.("could not read the provider catalog — reasoning effort will not be applied")
  }

  const defaultRef = parseModelRef(options.defaultModel),

  // A downgrade is a property of (model, effort), so it is the same message for every agent using
  // that pair. Emitting it once keeps a 15-agent fan-out from writing 15 identical log lines,
  // while still surfacing a DIFFERENT downgrade if another model or effort hits one.
   seenNotes = new Set<string>(),
   noteOnce = (note: string): void => {
    if (seenNotes.has(note)) {return}
    seenNotes.add(note)
    options.onNote?.(note)
  },

   resolvers = new Map<string, (effort: string | undefined) => string | undefined>(),
   resolverFor = (ref: ModelRef | undefined): ((effort: string | undefined) => string | undefined) => {
    const key = ref ? `${ref.providerID}/${ref.modelID}` : "<default>",
     existing = resolvers.get(key)
    if (existing) {return existing}
    const created = makeEffortResolver(variantsOf(catalog, ref), noteOnce)
    resolvers.set(key, created)
    return created
  }

  return {
    resolveModel: (model) => parseModelRef(model) ?? defaultRef,
    resolveVariant: (effort, model) => resolverFor(model ?? defaultRef)(effort),
  }
}
