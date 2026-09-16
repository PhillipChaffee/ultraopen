# Host lifecycle facts (verified 2026-09-15, opencode 1.18.31)

These facts decide the async-runs design. Each was verified by reading the pinned
opencode core or by a live spike (`spike-plugin.js` in the scratch directory).

## One-shot `opencode run` exits unconditionally after the turn

`packages/opencode/src/index.ts` ends with:

    } finally {
      // Explicitly exit to avoid any hanging subprocesses.
      process.exit()
    }

The `finally` runs after `cli.parse()` resolves, which is after the run command's
`finish()`, which resolves when the primary session goes idle. A ref'd interval
timer does NOT hold the process: a spike plugin returned from its tool with a
ref'd `setInterval(…, 500)` and an in-flight child prompt, and the process still
exited ~2 seconds after the turn, killing the background work silently.

Consequence: a detached run in one-shot mode dies with the process, mid-flight.
The journal flush and manifest keep the completed prefix; a later resume replays
it. The TUI and `opencode serve` are long-lived processes and keep runs alive.

## The model can still work in the same turn after the tool returns

A tool that returns early does not end the turn. The model can keep calling
tools and can block inside `workflow_status` with `wait`, which reproduces the
old blocking wall-clock from the model's point of view while the run stays
detached.

## Child sessions work after the tool call returns

The spike spawned a child session through the plugin client after the tool
returned and prompted it repeatedly; the prompts resolved while the parent turn
was still settling. The server serves child prompts after the launch turn.

## Aborts do not cascade to children

`spawn.ts` only aborts a child when the Run's own signal fires (per-agent
deadline, abortAll at script end). The host never cascades an abort to plain
`parentID` children — that is why the reaper exists. A detached run that simply
drops the tool-call signal therefore survives a parent-turn interrupt.

## Decisions recorded

- The tool returns at once by default (`runMode: "background"`). In one-shot
  `opencode run` the run lives only as long as the turn keeps working (polls
  via `workflow_status(wait)`) or the process stays up. The launch result says
  so plainly.
- `runMode: "blocking"` (option or `ULTRAOPEN_WORKFLOW_SYNC=1`) restores the
  pre-async behavior for one-shot users and as a rollback path. This is why a
  per-call blocking escape hatch exists despite the async default: the host's
  unconditional `process.exit()` makes lingering impossible in one-shot mode.
- No keepalive timer. It cannot beat `process.exit()`; long-lived hosts do not
  need it.