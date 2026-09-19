# ultraopen — agent notes

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (github.com/PhillipChaffee/ultraopen), driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage-role labels, used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `CONTEXT.md` and `docs/adr/` are created lazily by `/domain-modeling` when terms and decisions actually get resolved. See `docs/agents/domain.md`.

## Close-out gate

A ticket is done only when **every suite is green locally and the PR's CI is green** — code review and commit are not the close-out.

1. **Unit gate**: `bun run check` (lint + typecheck + full bun test with the 95% coverage gate + node sandbox parity). Criterion: zero failures. `bun` lives at `~/.bun/bin` and is absent from the default shell PATH — `export PATH="$HOME/.bun/bin:$PATH"` first.
2. **Real-harness e2e**: the bun suite never exercises live opencode; both suites below drive real opencode processes with real model calls (pennies) inside a scratch-isolated XDG home:
   - `bash test/e2e/technical.sh` — headless `opencode run` cases.
   - `bash test/e2e/visual.sh` — the real TUI in tmux (tmux required), the slower suite.
   Criterion: the summary reads `0 failed`. `✗` lines are failures to investigate; `·` lines are informational notes. Known upstream drift is recorded per the README's upstream note and expressed as a note, never a silent skip. When an e2e assertion fails, diagnose before touching anything: product regression, provider flake, or harness drift (an assertion that no longer matches what ships — fix the harness, as with T5a/V3).
3. **PR and CI**: open the PR with `gh pr create` (the GitHub MCP token cannot create PRs; reads work), fill the body's Test Plan with what actually ran, then `gh pr checks <n> --watch` until every check passes. Merge only on green.

**Every ticket ends with the finish line**: a ticket's body closes with a `## Close-out` section restating this gate — unit gate green, both e2e suites `0 failed`, PR opened, CI green, merged — so any agent picking the ticket up treats the gate as part of the work, not an afterthought.

**main is branch-protected by a branch ruleset** (`main: CI + review required`): required status checks (`check (ubuntu-latest)`, `check (macos-latest)`, `zizmor audit`, `coverage`) plus one approving review, enforced even for the owner. Solo merge path: `gh pr merge <n> --merge --admin` — self-approval is impossible, and the ruleset's bypass actors apply only through the web UI's bypass option, not the API.