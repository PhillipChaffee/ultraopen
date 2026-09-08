import { describe, expect, test } from "bun:test"
import { makeResolvers, parseModelRef, variantsOf } from "../src/server/bridge/models.js"
import type { CatalogClient, ProviderCatalog } from "../src/server/bridge/models.js"

const CATALOG: ProviderCatalog = {
  providers: [
    {
      id: "opencode",
      models: {
        "claude-opus-5": { variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } },
        "claude-sonnet-4-6": { variants: { low: {}, medium: {}, high: {}, max: {} } },
        "kimi-k2.6": {},
      },
    },
    { id: "together", models: { "Qwen/Qwen3.5": { variants: { low: {}, high: {} } } } },
  ],
},

 clientWith = (catalog: ProviderCatalog | undefined, fail = false): CatalogClient => ({
  config: {
    providers: () =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve(catalog === undefined ? {} : { data: catalog }),
  },
})

describe("parseModelRef", () => {
  test("splits provider from model", () => {
    expect(parseModelRef("opencode/claude-opus-5")).toEqual({ providerID: "opencode", modelID: "claude-opus-5" })
  })

  test("keeps slashes inside the model id", () => {
    // Model ids can contain slashes, so only the FIRST segment is the provider.
    expect(parseModelRef("together/Qwen/Qwen3.5")).toEqual({ providerID: "together", modelID: "Qwen/Qwen3.5" })
  })

  test.each([undefined, "", "no-slash", "/model", "provider/"])("rejects %p", (input) => {
    expect(parseModelRef(input)).toBeUndefined()
  })
})

describe("variantsOf", () => {
  test("reads a model's real variant set", () => {
    const result = variantsOf(CATALOG, { providerID: "opencode", modelID: "claude-opus-5" })
    expect(result.available).toEqual(["low", "medium", "high", "xhigh", "max"])
    expect(result.modelLabel).toBe("opencode/claude-opus-5")
  })

  test("a model with no variants reports an empty set", () => {
    expect(variantsOf(CATALOG, { providerID: "opencode", modelID: "kimi-k2.6" }).available).toEqual([])
  })

  test.each([
    ["unknown provider", { providerID: "nope", modelID: "claude-opus-5" }],
    ["unknown model", { providerID: "opencode", modelID: "nope" }],
  ])("%s reports an empty set", (_label, ref) => {
    expect(variantsOf(CATALOG, ref).available).toEqual([])
  })

  test("a missing catalog or ref reports an empty set", () => {
    expect(variantsOf(undefined, { providerID: "a", modelID: "b" }).available).toEqual([])
    expect(variantsOf(CATALOG, undefined).available).toEqual([])
  })
})

describe("makeResolvers", () => {
  test("resolves effort against the run's default model", async () => {
    const resolvers = await makeResolvers(clientWith(CATALOG), { defaultModel: "opencode/claude-opus-5" })
    expect(resolvers.resolveVariant("xhigh")).toBe("xhigh")
  })

  test("resolves effort against a PER-CALL model, not the default", async () => {
    // Variants belong to a model. Resolving a pinned model's effort against the run default would
    // send a variant that model may not support — the silent no-op this path exists to prevent.
    const notes: string[] = [],
     resolvers = await makeResolvers(clientWith(CATALOG), {
      defaultModel: "opencode/claude-opus-5",
      onNote: (note) => notes.push(note),
    }),

     pinned = resolvers.resolveModel("opencode/claude-sonnet-4-6")
    expect(resolvers.resolveVariant("xhigh", pinned)).toBe("high")
    expect(notes.some((note) => note.includes("claude-sonnet-4-6"))).toBe(true)
  })

  test("reports each distinct downgrade once, not once per agent", async () => {
    // A 15-agent fan-out on the same model would otherwise write 15 identical log lines.
    const notes: string[] = [],
     resolvers = await makeResolvers(clientWith(CATALOG), {
      defaultModel: "opencode/claude-sonnet-4-6",
      onNote: (note) => notes.push(note),
    })

    for (let i = 0; i < 15; i++) {resolvers.resolveVariant("xhigh")}
    expect(notes.length).toBe(1)
  })

  test("still reports a DIFFERENT downgrade", async () => {
    const notes: string[] = [],
     resolvers = await makeResolvers(clientWith(CATALOG), {
      defaultModel: "opencode/claude-sonnet-4-6",
      onNote: (note) => notes.push(note),
    })

    resolvers.resolveVariant("xhigh")
    resolvers.resolveVariant("turbo")
    expect(notes.length).toBe(2)
  })

  test("resolveModel falls back to the default when none is pinned", async () => {
    const resolvers = await makeResolvers(clientWith(CATALOG), { defaultModel: "opencode/claude-opus-5" })
    expect(resolvers.resolveModel(undefined)).toEqual({ providerID: "opencode", modelID: "claude-opus-5" })
    expect(resolvers.resolveModel("together/Qwen/Qwen3.5")).toEqual({
      providerID: "together",
      modelID: "Qwen/Qwen3.5",
    })
  })

  test("a catalog fetch failure degrades rather than throwing", async () => {
    const notes: string[] = [],
     resolvers = await makeResolvers(clientWith(undefined, true), {
      defaultModel: "opencode/claude-opus-5",
      onNote: (note) => notes.push(note),
    })

    // No variant is sent, and the run log says why — better than guessing one that may not exist.
    expect(resolvers.resolveVariant("xhigh")).toBeUndefined()
    expect(notes.some((note) => note.includes("could not read the provider catalog"))).toBe(true)
  })

  test("a client with no config surface degrades the same way", async () => {
    const resolvers = await makeResolvers({}, { defaultModel: "opencode/claude-opus-5" })
    expect(resolvers.resolveVariant("xhigh")).toBeUndefined()
  })

  test("works with no default model configured", async () => {
    const resolvers = await makeResolvers(clientWith(CATALOG), {})
    expect(resolvers.resolveModel(undefined)).toBeUndefined()
    expect(resolvers.resolveVariant("xhigh")).toBeUndefined()
  })
})
