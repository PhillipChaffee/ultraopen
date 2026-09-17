# ultraopen — agent notes

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues (github.com/PhillipChaffee/ultraopen), driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage-role labels, used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: a root `CONTEXT.md` and `docs/adr/` are created lazily by `/domain-modeling` when terms and decisions actually get resolved. See `docs/agents/domain.md`.