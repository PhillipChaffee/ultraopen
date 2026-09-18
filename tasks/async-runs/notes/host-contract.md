# The host-aware launch contract (2026-09-16)

Follow-up to the poll-until-settle compromise in `host-lifecycle-facts.md`: the async epic
detached the run from the tool call, but the launch result still told the model — in EVERY host —
to hold the turn by polling until the run settles. In a long-lived host that buys nothing: the
process survives the turn, so the pinning only blocked the chat for the whole run.

## Decision

The launch contract now follows the host shape (`isLongLivedHost` in
`src/server/tool/background.ts`):

- **Long-lived** (TUI, `opencode serve`, `opencode web`, `opencode acp`, `--mini`): the launch
  result and tool description free the turn — end it once the run is launched; poll
  `workflow_status` when the user asks about the run or the task needs the value.
- **One-shot** (`opencode run`, unknown shapes): today's poll-until-settle text, unchanged. An
  unsettled run dies with the process (`process.exit()` in the CLI `finally`), so freeing the turn
  there loses the run; pinning merely blocks. Unknown argv shapes keep the pinned contract — the
  failure directions are not symmetric.

## Evidence (live captures, installed opencode 1.18.31 binary)

- `opencode run "say hi"`: `["bun", "/$bunfs/root/src/index.js", "run", "say hi"]` — the plugin's
  server is in-process and carries the `run` token.
- `opencode serve`: `["bun", "/$bunfs/root/src/index.js", "serve", "--port", "..."]` — no `run`
  token; plugin instantiation happens per-directory on the first request that names one.
- TUI under tmux: the server runs in a Bun worker whose argv is the worker file alone
  (`["bun", "/$bunfs/root/src/cli/tui/worker.js"]`) — a Bun worker does not inherit the parent's
  argv. A local spike confirmed worker argv semantics directly.

## What this does NOT fix

The outcome still reaches the user only when they ask: there is no server→session push channel
(the upstream gap already recorded in the upstream-fixes epic). The TUI's disk poller shows live
progress regardless, and a dependent task still polls — the freed-turn text keeps the poll
guidance for "the user asks" and "the task cannot finish without the value". A push-style
"task completed" notification would need an upstream opencode feature.