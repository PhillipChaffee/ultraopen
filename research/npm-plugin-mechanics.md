# Research: how opencode installs and gates npm plugins

Resolves [PhillipChaffee/ultraopen#101](https://github.com/PhillipChaffee/ultraopen/issues/101)
(`wayfinder:research`, part of map #100). Question: when `opencode.json` / `tui.json` carry
`"plugin": ["ultraopen"]` (bare npm package name), what does opencode actually do?

## Sources and verification basis

| Source | What was checked |
| --- | --- |
| [opencode docs — Plugins](https://opencode.ai/docs/plugins) (fetched 2026-09-26) | Install claims, load order, npm form |
| [`packages/opencode/src/plugin/shared.ts` @ tag `v1.18.31`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/shared.ts) | Source classification, target resolution, entry resolution, compatibility gate, plugin-id rules |
| [`packages/opencode/src/plugin/loader.ts` @ tag `v1.18.31`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/plugin/loader.ts) | Stage pipeline, npm-only gate placement |
| [`packages/core/src/npm.ts` @ tag `v1.18.31`](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/core/src/npm.ts) | The actual installer |
| [`packages/opencode/src/plugin/index.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/index.ts) (dev branch) | Server-side load + error reporting |
| [`packages/opencode/src/plugin/tui/runtime.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/tui/runtime.ts) (dev branch) | TUI-side load, entry contract, host injection |
| [`packages/core/src/global.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/global.ts), [`packages/core/src/installation/version.ts`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/installation/version.ts) (dev branch) | Cache path, running-version source |
| Local `node_modules/@opentui/solid/scripts/runtime-plugin-support-configure.js`, `node_modules/@opentui/core/runtime-plugin.js` | The host-injection mechanism (the versions opencode 1.18.x itself depends on) |
| Local `node_modules/solid-js/package.json` (1.9.12), `bun.lock`, `node_modules/@opencode-ai/plugin/package.json` (1.18.25) | Dev-checkout trap evidence |
| Local `test/e2e/lib.sh`, `README.md`, `package.json`, `src/server/index.ts`, `src/tui/index.tsx` | ultraopen's own config, entries, harness behavior |
| [npm docs — `peerDependenciesMeta`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependenciesmeta) | Optional-peer install semantics |

Version note: upstream's dev branch is v2-era. `shared.ts` and `loader.ts` were fetched at **both**
dev and tag `v1.18.31` and are **byte-identical** (same blob SHAs), so the loader mechanics below are
verified at the exact version ultraopen targets (1.18.31, per `README.md:215`). `npm.ts` at the tag is
the same arborist mechanism with a minor entrypoint-resolution difference; `index.ts`/`runtime.ts` were
checked on dev only.

---

## 1. Resolution mechanics

### 1.1 A bare name is classified as an npm plugin, resolved to `name@latest`

`pluginSource(spec)` returns `"file"` only when the spec starts with `file://`, `./`-style relative
paths, or an absolute path (`isPathPluginSpec`, shared.ts). Anything else — including bare
`"ultraopen"` — is `"npm"`.

`resolvePluginTarget` then normalizes the specifier with `npm-package-arg`: when `hit.raw === hit.name`
(a bare name, no version), the install spec becomes `ultraopen@latest` (shared.ts,
`resolvePluginTarget`; same rule in `parsePluginSpecifier`, which is why install-failure messages read
`Failed to install plugin ultraopen@latest: …`).

### 1.2 Install: NOT Bun — `@npmcli/arborist`, into a per-package cache tree

`Npm.add(pkg)` (core/npm.ts):

- Target directory: `path.join(global.cache, "packages", sanitize(pkg))`. `Global.Path.cache` is
  `path.join(xdgCache!, "opencode")` (core/global.ts), i.e. `~/.cache/opencode/packages/ultraopen`
  on Linux, and `$XDG_CACHE_HOME/opencode/…` or `~/.cache/opencode/…` on macOS (the `xdg-basedir`
  package does not use `~/Library/Caches`).
- The installer is **`@npmcli/arborist`** — `arborist.reify({ add: [pkg], save: true, saveType: "prod",
  ignoreScripts: true })` under a flock named `npm-install:<dir>`. It is not `bun install`, and
  lifecycle scripts are **ignored** (`ignoreScripts: true`), so a plugin's `postinstall`/`prepare`
  never runs; the published tarball must already contain built output.
- **Short-circuit**: if `<cache-dir>/node_modules/ultraopen` already exists, `Npm.add` returns the
  existing entrypoint *without re-resolving the version* (core/npm.ts, `add`). Consequence:
  **`@latest` is first-install-wins** — the tree is sticky per user machine. A new publish does not
  reach existing users until they remove `~/.cache/opencode/packages/ultraopen` (or upstream changes
  this). Surprise finding; affects release comms (see §5).
- Docs drift: [docs/plugins](https://opencode.ai/docs/plugins) still says npm plugins are "installed
  automatically using Bun … cached in `~/.cache/opencode/node_modules/`". The code at both
  `v1.18.31` and dev says arborist + `~/.cache/opencode/packages/<name>`. Don't copy the docs wording
  into ultraopen's Install section.

### 1.3 Which export loads, per host

Both hosts share `createPluginEntry(spec, target, kind)` → `resolvePackageEntrypoint(spec, kind, pkg)`
(shared.ts):

- **Server host** (`kind: "server"`, plugin/index.ts `loadExternal`): reads `exports["./server"]`,
  accepting a plain string or an object's `import`/`default` value (`extractExportValue`). If
  `./server` is absent, it falls back to the package's `main` — **but only for the server kind**.
- **TUI host** (`kind: "tui"`, tui/runtime.ts `resolveExternalPlugins`): reads `exports["./tui"]`
  only. No `main` fallback. If absent → stage `missing`: the TUI logs
  `tui plugin has no entrypoint` and skips the package's code (a `tui.json`-only package can still
  contribute themes via an `oc-themes` package.json field — `readPackageThemes`, shared.ts).
- Resolution is confined to the package dir (`resolvePackageFile` throws if an export path escapes
  it), and the resolved path is imported with `await import(entry)` (loader.ts, `load`).

Config plumbing: `opencode.json`'s `plugin` array becomes `cfg.plugin_origins` for the server host
(plugin/index.ts); `tui.json`'s array reaches the TUI via `TuiConfig.pluginOrigins()`
(tui/runtime.ts `load`). The tuple form `["ultraopen", {…}]` forwards options into the plugin init
(`ConfigPlugin.pluginOptions`, loader.ts `plan`). Load order global→project config, then plugin
directories; npm duplicates with the same name+version load once
([docs/plugins — Load order](https://opencode.ai/docs/plugins)).

### 1.4 Module contract per host

- Server: `readV1Plugin(mod, spec, "server", "detect")` — the default export may be a **v1 object**
  `{ id?, server }` (detected by having an `id`/`server`/`tui` key) or **legacy** named function
  exports (`export const MyPlugin = async (ctx) => …`). A default export containing both `server`
  and `tui` is rejected (`must default export either server() or tui(), not both`).
- TUI: `readV1Plugin(mod, spec, "tui")` in **strict** mode — the default export **must** be an object
  with `tui()`; legacy function exports do not work on the TUI host (tui/runtime.ts `finish`).
- Plugin id: an explicit `id` on the v1 object wins; npm plugins fall back to the package.json
  `name` (`resolvePluginId`). File plugins *require* an explicit `id` — they have no package name to
  fall back on.

ultraopen already matches this contract: `src/server/index.ts:588` exports
`{ id: "ultraopen", server: ultraopen }` and `src/tui/index.tsx:208` exports
`{ id: "ultraopen", tui }` — one entry file per host, so the "not both" rule never bites.

### 1.5 Failure surface

Every loader stage (`install` / `entry` / `compatibility` / `load`) reports but does not crash the
host: the server publishes a session error event (`Failed to install plugin ultraopen@latest: …`,
`Plugin <spec> skipped: …` — plugin/index.ts `report`), the TUI logs `[tui.plugin]` console errors
(`tui plugin incompatible`, `failed to resolve tui plugin` — tui/runtime.ts `report`). Other plugins
continue loading; the failed one is dropped from the loaded list (loader.ts `loadExternal`).

---

## 2. Does the version-compatibility gate apply to npm plugins? Does `engines.opencode` matter?

**Yes and yes.** In `loader.ts` `resolve()`:

```ts
// npm plugins can declare which opencode versions they support; file plugins are treated
// as local development code and skip this compatibility gate.
if (base.source === "npm") {
  try {
    await checkPluginCompatibility(base.target, InstallationVersion, base.pkg)
  } catch (error) {
    return { ok: false, stage: "compatibility", error }
  }
}
```

(Comment and logic verbatim at tag `v1.18.31` — loader.ts. This confirms `README.md:64-65`.)

`checkPluginCompatibility` (shared.ts) mechanics:

1. **Skipped when the running version is not valid semver or is major 0** — so local/dev builds
   (`InstallationVersion` falls back to `"local"`, core/installation/version.ts) are never gated.
2. Reads the **installed plugin package's** `package.json` `engines.opencode`. Missing `engines`, or a
   non-string `engines.opencode`, means **no gate** — `engines.opencode` is opt-in for npm plugins.
3. A string range is checked with `semver.satisfies(runningVersion, range)`; failure throws
   `Plugin requires opencode <range> but running <version>`.

So for npm `ultraopen`, `engines.opencode: ">=1.18.20"` **is** the compatibility gate, evaluated at
every startup against the running opencode version, using the metadata of the *installed* (sticky-cache)
copy. `engines.node` is not consulted by the loader, and arborist treats `engines` as advisory anyway
([npm docs — engines](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#engines)). File
plugins (absolute paths, the current e2e and dev flow) skip the gate entirely.

The same gate code is present on the dev (v2-era) branch, and `">=1.18.20"` semver-satisfies a
`2.x` running version — the current floor silently admits opencode 2. Policy consequence in §5 and
the graduated ticket (see #101 resolution comment).

---

## 3. Optional peers in a published install — and why the SSR trap can't hit it

### 3.1 Optional peers are simply not installed

arborist's reify adds only `ultraopen@latest` plus its regular dependencies (ultraopen ships exactly
one: `acorn`, `package.json:32-34`). npm ≥7 semantics install `peerDependencies` automatically but
**"Npm will not automatically install optional peer dependencies"**
([npm docs — peerDependenciesMeta](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#peerdependenciesmeta)).
ultraopen marks all three TUI peers optional (`package.json:69-79`), so a published install's cache
tree contains `ultraopen` + `acorn` and **nothing else** — no `solid-js`, no `@opentui/*`.

This makes `peerDependenciesMeta.optional: true` **load-bearing, not cosmetic**: were the peers
non-optional, arborist would pull `solid-js` and the OpenTUI packages into the cache tree, and the
dev-checkout SSR trap below would hit every published user.

### 3.2 The host injection the peers rely on

The TUI host, at startup, calls
`ensureRuntimePluginSupport({ additional: keymapRuntimeModules })`
(tui/runtime.ts, top-of-file import from `@opentui/solid/runtime-plugin-support/configure`). That
function (local `node_modules/@opentui/solid/scripts/runtime-plugin-support-configure.js:42-72`)
registers a **global Bun plugin** whose job is to serve the host's own live module instances under
virtual ids:

- Exact bare specifiers are mapped to virtual `opentui:runtime-module:<spec>` ids:
  `solid-js`, `solid-js/store`, `@opentui/solid`, `@opentui/solid/components`,
  `@opentui/solid/jsx-runtime`, `@opentui/solid/jsx-dev-runtime` (configure.js:12-19) plus
  `@opentui/core`/`@opentui/core/testing` and the keymap runtime modules
  (`node_modules/@opentui/core/runtime-plugin.js:308-433`).
- The virtual modules are backed by **the host's own already-imported module objects**
  (`build.module(moduleId, …)` serving the host instances — runtime-plugin.js:429-432), so plugin and
  host share one Solid runtime and one set of signals.
- For `node_modules` ESM the plugin cannot rely on `onResolve` ("Bun may native-load `node_modules`
  ESM without firing `onResolve` for nested package imports", runtime-plugin.js:17-19), so it
  prescans and installs exact-path `onLoad` loaders that rewrite import specifiers in files whose
  graph needs runtime modules.

The observable rule that matters (documented in `README.md:248-252` and `test/e2e/lib.sh:155-161`):
**the host's instances win only when the plugin directory cannot resolve the packages locally; a
resolvable local copy shadows the injection.**

### 3.3 Why the dev checkout traps and a published install doesn't

- Dev checkout: `bun install` materializes `solid-js@1.9.12` into the repo's `node_modules`
  (`bun.lock:329` — pulled both by ultraopen's own peer range, `bun.lock:23`, and by
  `@opentui/solid`'s non-optional peer, `bun.lock:135`; `@opentui/core`/`@opentui/solid` are explicit
  devDependencies). Now `dist/tui.js` *can* resolve `solid-js` locally → local copy shadows the host
  injection → and solid-js's export map resolves the `"node"`/`"import"` conditions to
  **`./dist/server.js` — the SSR build** (`node_modules/solid-js/package.json:67-70`; the client
  build only appears under `"browser"`, lines 52-61; solid-js has no `"bun"` condition, and Bun
  evaluates `node`). SSR-registry signals never update → the surfaces render nothing, silently.
  Workaround: `tui-dev.sh`/e2e stash `solid-js` + `@opentui` out of `node_modules` for the TUI's
  lifetime (`test/e2e/lib.sh:162-184`).
- Published install: the cache tree has no `solid-js`/`@opentui` (§3.1), so the plugin directory
  *cannot* resolve them → the host's virtual runtime modules win → the plugin shares the host's
  client-build Solid → the trap cannot occur. The README's claim is structurally true, not luck.

Residual caveat: Bun resolves imports by walking the real filesystem upward, so a stray
`solid-js` in an ancestor directory (`~/node_modules`, `~/.cache/opencode/node_modules`, …) could in
principle shadow the injection for a published install too. Unlikely; worth remembering if a user
ever reports a blank TUI from an npm install.

Honesty note on mechanism depth: *exactly* when Bun consults plugin `onResolve` versus native-loads
`node_modules` ESM is Bun-internals territory (the upstream runtime-plugin header documents the
workaround rather than a guarantee). The "cannot resolve locally → host injects" rule is the
validated, documented behavior; the underlying mechanism above is source-verified from the exact
package versions opencode 1.18.x depends on.

---

## 4. What package.json shape do published opencode plugins need?

From the loader's own reading of the installed package (`readPluginPackage` → shared.ts):

| Field | Why the loader cares |
| --- | --- |
| `name` | npm plugin id fallback (`resolvePluginId`) and the sticky-cache directory identity. Required for npm plugins. |
| `exports["./server"]` | Server entrypoint. String or `{ import: "…" }` / `{ default: "…" }`. Falls back to `main` if absent (server kind only). |
| `exports["./tui"]` | TUI entrypoint. Same value forms. No `main` fallback; absence = "no tui entrypoint" (code skipped; themes still work). |
| `"type": "module"` + ESM dist | Entries are `import`ed; also feeds the runtime-plugin's ESM detection for rewriting. |
| `files` | arborist installs the published tarball, and `ignoreScripts: true` means no build runs at install — **dist must be in the tarball**. Always-included: `package.json`, `README`, `LICENSE` ([npm docs — files](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files)). |
| `engines.opencode` | The npm-only compatibility gate (§2). Optional; omit = ungated. Must be a string semver range. |
| `peerDependencies` + `peerDependenciesMeta.optional: true` | Keeps the TUI peers out of the published cache tree (§3.1) — required for published installs to keep working. |
| `oc-themes` | Optional array of relative theme-file paths for TUI theme distribution (`readPackageThemes`, shared.ts). |

## What this means for publishing ultraopen

1. **The current `package.json` is already the right shape** — nothing must change before publish:
   `exports["./server"]` + `exports["./tui"]` with `import` conditions (`package.json:14-21`),
   `"type": "module"`, `files: ["dist", "skills", …]` (`package.json:22-28`), and
   `peerDependenciesMeta` optional on all three peers (`package.json:69-79`). The v1 default-export
   contract is satisfied per host (`src/server/index.ts:588`, `src/tui/index.tsx:208`).
2. **Do not "fix" the optional peers into hard peers.** Optional is what keeps `solid-js` (SSR build)
   out of the published cache tree and the TUI rendering (§3).
3. **`engines.opencode: ">=1.18.20"` is live** for npm users: on opencode < 1.18.20 the plugin is
   *skipped* with a session/TUI error (not a crash); on opencode 2.x the range currently *passes*.
   Whether to keep the open floor, add an upper bound, or leave version policy to README guidance is
   now a precise decision — graduated to a grilling ticket (see #101 resolution comment).
4. **Surprise for release comms: npm installs are sticky.** `ultraopen@latest` is resolved only on
   first install; the arborist cache (`~/.cache/opencode/packages/ultraopen`) short-circuits later
   loads without checking the registry. Existing users do not receive a new publish until they
   `rm -rf ~/.cache/opencode/packages/ultraopen`. The Install section and announcement drafts should
   say how to update (and this should be verified empirically by the clean published-install proof
   ticket before release copy is locked).
5. **Don't copy upstream's stale docs wording** ("installed using Bun … cached in
   `~/.cache/opencode/node_modules/`") into the README — the mechanism is arborist into
   `~/.cache/opencode/packages/<name>` (§1.2).
6. **Dev loop unchanged**: the `tui-dev.sh`/e2e stash workaround (`test/e2e/lib.sh:162-184`) remains
   necessary only for dev checkouts; published users need nothing.
7. No `postinstall`/`prepare` will ever run in a published install (`ignoreScripts: true`,
   core/npm.ts) — `prepublishOnly` building `dist/` before tarball creation is the only build path,
   which is already wired (`package.json:54`).

## Gaps / not directly verified

- No live published-style install was executed in this session (that proof is its own map ticket —
  the destination's "clean published-style install in a scratch home"). Every claim above is
  source-verified against tag `v1.18.31` / dev plus the exact local package versions; the
  sticky-cache (§1.2) and arborist optional-peer (§3.1) behaviors are the two that most deserve an
  empirical confirm during that proof.
- Bun's exact `onResolve`-versus-native-load trigger conditions are Bun internals; the injection
  rule is cited from documented/validated behavior (§3.2 honesty note).