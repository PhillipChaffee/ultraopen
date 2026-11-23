ultraopen {{VERSION}} is out.

ultraopen 0.2.x targets OpenCode V2 (`opencode >= 2.3.2 < 3`). The V1 line is frozen at 0.1.0.
The full working, known-gap, and cosmetic inventory — each probe with its implementation note —
lives in [docs/compatibility.md](https://github.com/PhillipChaffee/ultraopen/blob/main/docs/compatibility.md).

## Updating an existing install

Published installs are cached and a dist-tag resolves only when an install runs — a new release
doesn't reach an existing install on its own. To pick this one up:

```bash
rm -rf ~/.cache/opencode/npm/ultraopen*
```

then restart opencode. To pin a version instead, name it:
`{ "plugins": ["ultraopen@{{VERSION}}"] }` installs into a versioned cache tree, and
`opencode plugin add ultraopen@<newer>` rewrites the pin. Options live in the entry's `options`
object:

```json
{ "plugins": [{ "package": "ultraopen", "options": { "concurrency": 8 } }] }
```

Previews publish to the `next` tag as `0.2.0-next.N`; the first stable release publishes
`0.2.0` to `latest` once the live e2e suites pass against the registry-installed package.
