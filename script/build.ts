/**
 * Builds the dual-entry package.
 *
 * The two halves are built SEPARATELY because both entry files are named `index`, and a single
 * build would have them overwrite each other. They never exchange objects — the server writes
 * progress to disk and the TUI reads it — so they do not need to share a chunk, and an
 * `instanceof` across the boundary never happens.
 *
 * `--target node` because opencode ships a Node build and `PluginInput.$` is undefined whenever
 * `typeof Bun === "undefined"`.
 */
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"

const OUT = "dist",

/**
 * Left unbundled at runtime.
 *
 * The TUI runtime shares the host's module instances: a bundled second copy of solid-js would give
 * the plugin its own reactive owner graph, and its components would never update.
 */
 EXTERNAL = [
  "solid-js",
  "solid-js/*",
  "@opentui/core",
  "@opentui/solid",
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/*",
]

await rm(OUT, { recursive: true, force: true })

for (const [entry, name] of [
  ["src/server/index.ts", "server.js"],
  ["src/tui/index.tsx", "tui.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: OUT,
    target: "node",
    format: "esm",
    external: EXTERNAL,
  })

  if (!result.success) {
    for (const log of result.logs) {console.error(log)}
    process.exit(1)
  }

  // Both entry files are called `index`, so rename to the names the exports map points at.
  await rename(join(OUT, "index.js"), join(OUT, name))
  console.log(`  ${OUT}/${name}`)
}

console.log("built 2 entries")
