ultraopen {{VERSION}} is out.

ultraopen is tested against opencode 1.18.x and aims to keep current with opencode releases. The
full working, known-gap, and cosmetic inventory — each probe with its implementation note — lives
in [docs/compatibility.md](https://github.com/PhillipChaffee/ultraopen/blob/main/docs/compatibility.md).

## Updating an existing install

Published installs are cached and `@latest` resolves only on first install — a new release doesn't
reach an existing install on its own. To pick this one up:

```bash
rm -rf ~/.cache/opencode/packages/ultraopen*
```

then restart opencode. To pin a version instead, name it: `plugin: ["ultraopen@{{VERSION}}"]`
installs into a versioned cache tree, and `opencode plugin ultraopen@<newer> -g -f` rewrites the
pin (`-f` rewrites config entries; it never refetches a bare `@latest`).