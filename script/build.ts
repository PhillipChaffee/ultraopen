/**
 * Builds the dual-entry package.
 *
 * `--splitting` is REQUIRED, not an optimisation: without it Bun inlines a private copy of every
 * shared module into each entry, so `./server` and `./tui` would get DIFFERENT
 * `WorkflowScriptError` classes and `instanceof` across the boundary would silently return false.
 *
 * `--target node` because opencode ships a Node build and `PluginInput.$` is undefined whenever
 * `typeof Bun === "undefined"`.
 */
import { rm } from "node:fs/promises"

const entrypoints = ["src/server/index.ts"]

await rm("dist", { recursive: true, force: true })

const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  target: "node",
  format: "esm",
  splitting: true,
  // acorn is bundled: it is pure JS with no transitive dependencies, and vendoring it keeps the
  // published package free of a postinstall-capable dependency tree.
  external: [],
  // The exports map points at ./dist/server.js; the entry file is index.ts, so name it explicitly
  // rather than relying on the entrypoint's basename.
  naming: { entry: "server.js", chunk: "[name]-[hash].js" },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

for (const output of result.outputs) console.log(`  ${output.path}`)
console.log(`built ${result.outputs.length} file(s)`)
