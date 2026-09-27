# ADR-0003: npm publishing via trusted publisher (OIDC), no token

- **Status:** Accepted
- **Date:** 2026-09-27
- **Deciders:** Phillip Chaffee, with the npm-identity task (#103) and the release-shape grilling (#105); executed and proven in #111

## Context

ultraopen publishes to npm as the unscoped `ultraopen` package under the personal npm user
`phillipchaffee`, whose account enforces 2FA auth-and-writes. Releases are tag-driven: pushing a
`v*` tag runs `release.yml`, which asserts tag==version, runs the full gate, builds, and publishes.
That leaves the standard CI-publishing choice: store an npm automation token as a repo secret, or
use npm trusted publishing — GitHub Actions assumes an OIDC identity npmjs.com already whitelisted.

Two upstream facts constrain it:

- A package's trusted publisher can only be configured **after** the package exists on npm, so the
  first publish cannot be OIDC.
- Trusted publishing requires npm ≥ 11.5.1 and node ≥ 22.14 on the runner, and the published
  `repository.url` must match the GitHub repo exactly or provenance attestation fails.

## Decision

1. **Publish via trusted publishing; no npm token exists as a repo secret, and none will be minted
   for CI.** The OIDC path is the only automated publish path. `release.yml` carries
   `id-token: write`, pins npm@latest for the version floor, and publishes with provenance
   attestation as the default.
2. **The binding is `PhillipChaffee/ultraopen` / `release.yml`, with allow-direct-publish checked**
   (packages configured after Sep 3, 2026 default to stage-only, which would strand the workflow at
   the staging step).
3. **v0.1.0 is the deliberate exception:** it published locally over 2FA from a clean checkout —
   the binding cannot precede the package's existence — so it ships without provenance. The
   publish-guard skip in `release.yml` keeps a re-push of the v0.1.0 tag green. Every publish from
   v0.1.1 onward attests provenance automatically.

## Considered options

- **Granular automation token as a repo secret (rejected):** a leaked secret can publish, secrets
  carry a rotation burden, and the 2FA auth-and-writes account makes the interactive local publish
  the natural exceptional fallback anyway — no token needed to cover the rare case.

## Consequences

- Publishing requires the GitHub Actions environment, not a machine holding a credential; there is
  no publish-capable secret to steal.
- Provenance shows on npmjs.com for every release after v0.1.0 — a visible, explainable asymmetry,
  not a defect.
- The binding is environment-sensitive: renaming the repo or the workflow file breaks publishing
  until npmjs.com is updated. The tag==version fail-fast and the already-published guard make the
  failure loud in the workflow run, not silent.
- Local publishes remain possible over 2FA for exceptional cases, at the cost of provenance.

## Vocabulary

See `CONTEXT.md` (trusted publisher, registry hop, sticky cache, refresh instruction, open floor).