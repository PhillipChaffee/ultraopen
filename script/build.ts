/**
 * Builds the three ESM package entries (`server.js`, `rpc.js`, `tui.js`).
 *
 * The entries are built separately because `src/server/index.ts` and `src/tui/index.tsx` are both
 * named `index`, and `tui.js` requires `@opentui/solid/bun-plugin`'s Solid JSX transform so
 * reactive signals and `<Show>`/`<For>` compile to universal Solid calls instead of `jsx-runtime`.
 *
 * `--target node` because opencode ships a Node build and runtime hosts inject the externalized
 * `@opencode/plugin*`, `effect*`, `solid-js*`, and `@opentui/*` modules.
 */
import { rm } from "node:fs/promises"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

/**
 * Left unbundled at runtime so OpenCode V2's runtime module loader injects the host's instances.
 *
 * Bundling a second copy of `solid-js`, `@opentui/*`, `@opencode/plugin*`, or `effect*` would
 * break reactive ownership and host contract identity.
 */
const EXTERNAL = [
  "solid-js",
  "solid-js/*",
  "@opentui/core",
  "@opentui/core/*",
  "@opentui/solid",
  "@opentui/solid/*",
  "@opencode/plugin",
  "@opencode/plugin/*",
  "effect",
  "effect/*",
]

interface BuildEntry {
  readonly entry: string
  readonly name: string
  readonly solid?: boolean
}

/**
 * The slice of `Bun.build`'s result the gate reads.
 *
 * Kept narrow so a test can inject a failed build and prove the gate throws
 * instead of shipping a partial bundle — `Bun.build` itself rejects rather
 * than resolving `success: false` for the failures we can provoke.
 */
interface BuildOutcome {
  readonly success: boolean
  readonly logs: readonly unknown[]
}

type EntryBuilder = (spec: BuildEntry) => BuildOutcome | Promise<BuildOutcome>

const ENTRIES: readonly BuildEntry[] = [
  { entry: "src/server/index.ts", name: "server.js" },
  { entry: "src/rpc.ts", name: "rpc.js" },
  { entry: "src/tui/index.tsx", name: "tui.js", solid: true },
]

async function buildEntry(spec: BuildEntry, outdir: string): Promise<BuildOutcome> {
  const result = await Bun.build({
    entrypoints: [spec.entry],
    outdir,
    target: "node",
    format: "esm",
    external: EXTERNAL,
    naming: spec.name,
    ...(spec.solid ? { plugins: [createSolidTransformPlugin()] } : {}),
  })
  return result
}

/** Builds all package entry points into `outdir`, throwing on the first failed entry. */
export async function buildAll(
  outdir = "dist",
  build: EntryBuilder = (spec) => buildEntry(spec, outdir),
): Promise<void> {
  await rm(outdir, { recursive: true, force: true })

  for (const spec of ENTRIES) {
    const result = await build(spec)

    if (!result.success) {
      for (const log of result.logs) {console.error(log)}
      throw new Error(`Failed to build ${spec.entry} -> ${outdir}/${spec.name}`)
    }

    console.log(`  ${outdir}/${spec.name}`)
  }

  console.log(`built ${ENTRIES.length} entries`)
}

if (import.meta.main) {
  await buildAll()
}
