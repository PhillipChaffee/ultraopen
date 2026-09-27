# Where the opencode community surfaces plugins

Resolves [PhillipChaffee/ultraopen#102](https://github.com/PhillipChaffee/ultraopen/issues/102). Research date: 2026-09-26. Facts and rules only — drafting is ticket #106's job; posting is Phillip's.

**ultraopen** in one line: deterministic multi-agent workflow orchestration for opencode, shipped as an opencode plugin (npm package), repo `github.com/PhillipChaffee/ultraopen`.

## How to read this

- **Listing venues** (durable entries in a directory): sections 1–6. An agent can execute 1–3; 4–6 are gated or marginal.
- **Announcement venues** (one-off posts): r/opencode (7) and the opencode Discord (8) were already decided as venues in #100's charting, together with an X thread (9, decided upstream, not re-researched here). This file records what could and could not be verified about their rules.
- Verdicts: **green light** (do it), **caution** (do it with a stated condition), **skip**.

## Venue inventory

### 1. Official opencode Ecosystem page — GREEN LIGHT

- **What**: the official opencode docs page that lists community plugins, projects, and agents. https://opencode.ai/docs/ecosystem
- **Source of truth**: `packages/web/src/content/docs/ecosystem.mdx` in `github.com/anomalyco/opencode` (default branch: `dev`).
- **How to submit**: open a PR adding a row to the **Plugins** table. The page itself says: "Want to add your OpenCode related project to this list? Submit a PR."
- **Row format observed**: `[name](repo-url)` + a one-line description, alphabetical-ish grouping by function. No other fields.
- **Observed practice**: 530 PRs match "ecosystem" in the title, with a consistent naming pattern — `docs(ecosystem): add <name> to ecosystem plugins` (examples: [#49848](https://github.com/anomalyco/opencode/pull/49848), [#51099](https://github.com/anomalyco/opencode/pull/51099)). The table is full of entries that arrived this way, so the flow works.
- **Caution**: several ecosystem-add PRs sampled were still **open** at research time — merge timing is not guaranteed and there is no stated SLA.
- **Also official**: the [Plugins docs page](https://opencode.ai/docs/plugins) documents npm-plugin loading (`"plugin": [...]` in opencode.json) and points readers to "Browse available plugins in the ecosystem" → this same page. So once listed, npm-installed discovery flows through it.
- **Verdict**: green light. Official, self-serve, no gatekeeping beyond review; the single highest-value listing.

### 2. awesome-opencode/awesome-opencode — GREEN LIGHT (after 0.1.0 ships)

- **What**: the flagship community awesome list for opencode — "A curated list of awesome plugins, themes, agents, projects, and resources for https://opencode.ai". ~10.4k stars, 909 forks, active (updated daily), awesome-list badge. https://github.com/awesome-opencode/awesome-opencode
- **How to submit**: fork + PR adding `data/plugins/ultraopen.yaml` (kebab-case filename). Do **not** edit README.md — it auto-regenerates from YAML.
- **YAML fields**: `name`, `repo` (URL), `tagline` (max 120 chars, shown collapsed), `description` (longer).
- **Entry requirements**: Relevant (directly opencode-related) · Public repo · Maintained (active commits within the last 6 months) · Unique · Complete fields.
- **Flow**: automated YAML validation on the PR → maintainer review → merge → README regenerates.
- **Precedent**: orchestration/workflow plugins are already listed — FlowDeck (multi-agent workflow orchestration), GoopSpec (spec-driven workflow), Open Dynamic Workflows, CrewBee, opencode-workspace (multi-agent orchestration harness). 136 YAML entries in `data/plugins/` at research time. ultraopen has direct, accepted neighbors.
- **Verdict**: green light, gated only on the public npm release existing. Watch the 6-month-activity rule afterward.

### 3. opencode.cafe — GREEN LIGHT

- **What**: a community marketplace/aggregator for opencode extensions ("A cozy corner… share extensions, plugins, and tools for OpenCode"). Explicitly endorsed by the official Ecosystem page ("You can also check out … opencode.cafe, a community that aggregates the ecosystem"). Not affiliated with OpenCode/SST — the site says so itself. https://opencode.cafe · source: https://github.com/R44VC0RP/opencode.cafe
- **How to submit**: the submission form at https://opencode.cafe/submit (client-rendered; form internals not inspectable from this environment). Site categories include Plugins.
- **Rules** (from https://opencode.cafe/guidelines):
  - **Must have**: public repository with source code; clear and accurate description; installation instructions that work; related to OpenCode; no malicious code.
  - **Recommended**: README with documentation; license file; examples or screenshots; version information; support contact.
  - **Common rejection reasons**: private/inaccessible repo; misleading description; broken install instructions; unrelated to OpenCode; duplicate; inappropriate content; "appears to be spam or low-effort".
- **Process**: submissions enter a review queue; "we aim to review submissions within a few days"; approval or rejection **with feedback**; rejected submissions can be fixed and resubmitted.
- **Verdict**: green light. Documented rules, cheap flow, reviewer feedback loop. Watch the "low-effort" rejection cause — submit with a complete README and license in place.

### 4. awesome-agent-orchestrators — CAUTION (premature, then yes)

- **What**: awesome list for agent orchestrators — swarms, loop runners, task runners, infrastructure — with an OpenCode-ecosystem presence (2k stars; web twin https://agent-orchestrators.com). https://github.com/andyrewlee/awesome-agent-orchestrators
- **How to submit**: PR titled `Add X to <Section>`, **one entry per PR**, body one line, one-line README description in house style (capitalized, ends with a period, says what it does and which agents it supports), alphabetical placement, awesome-lint enforced in CI.
- **Rules** (CONTRIBUTING.md): Open (source-available, entry links to the repo, not a marketing site) · **Adopted — at least 5 GitHub stars and signs of life (recent commits or releases); "Strong projects early in their life are welcome back once they have traction"** · Fitting (one existing section without diluting it — for ultraopen: Multi-Agent Swarms or Agent Infrastructure & Primitives) · Described. Quiet projects move to a Resting section, not deleted.
- **Verdict**: caution — ultraopen is brand-new with no star history; submitting now fails the Adopted bar. Revisit once ≥5 stars with recent commits. Not a skip: this list is exactly ultraopen's category.

### 5. bradAGI/awesome-cli-coding-agents — CAUTION (fit is partial)

- **What**: 130+ CLI coding agents plus the harnesses that orchestrate them (1.3k stars, actively updated). https://github.com/bradAGI/awesome-cli-coding-agents
- **How to submit**: PRs welcome. Inclusion criteria: must have a **CLI or terminal interface**; must be able to **read/write code or run commands autonomously**; link must be valid and active. Entry format: name + link, star count, 1–2 line description; optional provider tag/license/notes.
- **Verdict**: caution — ultraopen is a plugin, not itself a CLI agent; it can only plausibly fit the "Harnesses & orchestration" section, and the list is not opencode-specific. Lower priority than 1–4.

### 6. hashgraph-online/awesome-ai-plugins — CAUTION (marginal)

- **What**: cross-harness plugin list (Claude Code, Codex, Gemini, OpenCode, and more; 346 stars), with CONTRIBUTING.md and an automated contribution-validation workflow (`.github/workflows/validate-contribution.yml`). https://github.com/hashgraph-online/awesome-ai-plugins
- **Verdict**: caution/marginal — cross-harness lists dilute opencode-specific discoverability and the process is heavier; only worth it if the opencode-specific venues are exhausted.

### 7. r/opencode (Reddit) — CAUTION (rules could NOT be verified from here)

- **What**: the opencode subreddit. Community members do post plugins there (search snippets show plugin authors announcing npm-distributed opencode plugins on the subreddit). https://www.reddit.com/r/opencode/
- **Rules**: **could not be verified.** Every route tried from this environment was refused by Reddit's network security with 403 — `www.reddit.com/r/opencode/about/rules.json`, `old.reddit.com` (HTML and JSON), `np.reddit.com`, and a reader proxy (`r.jina.ai`), the last returning: "You've been blocked by network security. To continue, log in to your Reddit account or use your developer token."
- **What is verifiable**: the subreddit exists and is active; sitewide, Reddit has general self-promotion culture and guidance (third-party 2026 guides commonly cite the 90/10 heuristic, but those are **not** r/opencode's rules and should not be treated as such).
- **Required human step**: read the live rules at https://www.reddit.com/r/opencode/about/rules/ (and the subreddit About/sidebar) in a logged-in browser **before** the r/opencode post in #106 goes out. Exactly what is allowed for tool self-promotion on r/opencode could not be confirmed without this.
- **Verdict**: caution — the venue is right (decided in #100) and plugin announcements demonstrably happen there, but rule compliance must be verified in a browser first.

### 8. opencode Discord — CAUTION (channel structure could NOT be verified)

- **Invite**: https://discord.gg/opencode (canonical `https://discord.com/invite/opencode`) — linked from the opencode docs footer ("Join our Discord community") and the anomalyco/opencode README ("Join our community: Discord | X.com"). Server name "OpenCode"; **85,918 members, ~8,709 online** (Discord invite page + widget API, 2026-09-26). Guild ID `1391832426048651334`.
- **Channels**: the public Discord widget exposes only two channels — `smp-opencode-cafe` (position 6; the name echoes opencode.cafe) and `voice`. The full channel list — including any showcase/help/show-and-tell channels — is not visible without joining.
- **Could NOT be verified**: which channel(s) accept plugin announcements, and any documented etiquette (pinned rules, posting format). Nothing in the docs or repo specifies this. Do not guess a channel name.
- **Required human step**: Phillip (or any member) joins once, records which channel takes plugin announcements and any pinned etiquette, and that feeds #106's Discord draft.
- **Verdict**: caution — venue decided in #100 with 85k+ members of reach, but channel selection needs a human join step.

### 9. X thread — noted, no research needed

- Decided in #100's charting as the third announcement venue. X has no submission mechanics for a listing; it is covered by #106's draft work. Out of this ticket's scope.

## Checked and ruled out (not venues)

- **GitHub Discussions on anomalyco/opencode**: the repo has discussions **disabled** (`has_discussions: false`) — there is no discussions-based showcase to post to.
- **Newsletters/blogs tracking opencode plugins**: targeted searches surfaced none beyond opencode.cafe's aggregation. No credible newsletter found.
- **opencode CHANGELOG / release notes**: these cover opencode itself; there is no third-party plugin section to submit to.
- **awesome-llm-skills and skill registries**: publishing the workflow-authoring skill to skill registries is explicitly out of scope per #100.
- **Show HN / Product Hunt**: explicitly ruled out of scope in #100 ("revisit as a fresh effort once real user feedback exists").

## Standing rule worth honoring (naming)

The anomalyco/opencode README, section "Building on OpenCode": *"If you are working on a project that's related to OpenCode and is using 'opencode' as part of its name, for example 'opencode-dashboard' or 'opencode-mobile', please add a note to your README to clarify that it is not built by the OpenCode team and is not affiliated with us in any way."*

"ultraopen" does not contain the string "opencode", so the rule's letter does not apply. A short "not made by the OpenCode team" line in ultraopen's README is still a cheap way to honor the rule's spirit — and matches what listed plugins (opencode.cafe included) already do.

## Suggested venue set (feeds #106 and the posting-checklist fog item)

- **Listing, agent-executable**: 1 (ecosystem PR), 2 (awesome-opencode YAML PR), 3 (opencode.cafe form).
- **Announcement, Phillip posts**: 7 (r/opencode — verify rules in browser first), 8 (Discord — identify channel by joining first), 9 (X).
- **Defer until traction**: 4 (awesome-agent-orchestrators, ≥5 stars); optional: 5, 6.

## Sources

- https://opencode.ai/docs/plugins — npm plugin loading; "Browse available plugins in the ecosystem" → /docs/ecosystem#plugins
- https://opencode.ai/docs/ecosystem — "Submit a PR" note; Plugins/Projects/Agents tables
- `github.com/anomalyco/opencode` — README (Discord invite, "Building on OpenCode" rule), `packages/web/src/content/docs/ecosystem.mdx`, PR search (530 "ecosystem" PRs), repo metadata (`has_discussions: false`, default branch `dev`)
- `github.com/awesome-opencode/awesome-opencode` — contributing.md (YAML flow + entry requirements), `data/plugins/` (136 entries), README (categories)
- https://opencode.cafe — homepage, /guidelines, /submit; `github.com/R44VC0RP/opencode.cafe`
- `github.com/andyrewlee/awesome-agent-orchestrators` — CONTRIBUTING.md
- `github.com/bradAGI/awesome-cli-coding-agents` — README Contributing section
- `github.com/hashgraph-online/awesome-ai-plugins` — CONTRIBUTING.md + validation workflow (via code search)
- https://www.reddit.com/r/opencode/ — **blocked** from this environment (403 via www/old/np and r.jina.ai proxy; Reddit's block message captured verbatim in §7)
- https://discord.gg/opencode invite page + Discord widget API (`/api/guilds/1391832426048651334/widget.json`) — member counts, widget-visible channels

## Open gaps (what could NOT be confirmed here)

1. **r/opencode's specific rules** — needs a logged-in browser; Reddit blocks non-authenticated fetchers.
2. **Discord announcement channel + etiquette** — needs joining the server; only `smp-opencode-cafe` and `voice` are publicly visible via widget.
3. **opencode.cafe submit-form internals** — client-rendered; field list not inspectable here (guidelines page does document requirements).
4. **Ecosystem PR merge cadence** — the flow is proven (table is populated via PRs) but several sampled add-PRs were open; timing unverified.