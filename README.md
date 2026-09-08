# ultraopen

Deterministic multi-agent workflow orchestration and an `ultracode` effort mode for
[opencode](https://github.com/anomalyco/opencode) — the open-source AI coding agent that runs in
your terminal.

[![CI](https://github.com/PhillipChaffee/ultraopen/actions/workflows/ci.yml/badge.svg)](https://github.com/PhillipChaffee/ultraopen/actions/workflows/ci.yml)
[![Lint](https://github.com/PhillipChaffee/ultraopen/actions/workflows/lint.yml/badge.svg)](https://github.com/PhillipChaffee/ultraopen/actions/workflows/lint.yml)
[![Coverage](https://github.com/PhillipChaffee/ultraopen/actions/workflows/coverage.yml/badge.svg)](https://github.com/PhillipChaffee/ultraopen/actions/workflows/coverage.yml)
[![Security](https://github.com/PhillipChaffee/ultraopen/actions/workflows/security.yml/badge.svg)](https://github.com/PhillipChaffee/ultraopen/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![opencode](https://img.shields.io/badge/opencode-%3E%3D%201.18.20-7C3AED)](https://github.com/anomalyco/opencode)
[![Made with Bun](https://img.shields.io/badge/made_with-Bun-C0242E?logo=bun&logoColor=white)](https://bun.sh/)

**1,000 agents per run · schema-validated outputs · resumable by journal**

A workflow is a deterministic JavaScript driver in which `agent()` is the only nondeterministic
call. Control flow — fan-out, loops, dedup, thresholds, early exit, synthesis — is real code, so
runs are reproducible and resumable: resume a failed run and the agents that already finished
replay from the journal instead of running — and billing — again.

```javascript
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
  )),
)

return { confirmed: results.flat().filter(Boolean) }
```

## What a run looks like

No GIF ships with this repo — run `bash test/e2e/tui-dev.sh` for the live thing. Mid-flight, the
`review-changes` run above renders on three surfaces (recreated here exactly as the surfaces
format themselves):

```
┌────────────────────────────────────────────────────────────┐
│                                                            │ ┌ ultracode ───────────┐
│                 your transcript, as always                 │ │ review-changes ·     │
│                                                            │ │ Verify · 3/5 · 12s   │
│                                                            │ │ ⠋ review:bugs        │
│                                                            │ │ ⠋ review:perf        │
│                                                            │ │ ✗ review:security    │
└────────────────────────────────────────────────────────────┘ └──────────────────────┘
┌ input ──────────────────────────────────────────────────────────────────────────────┐
│ > _                                                        ultracode ⠋ Verify · 3/5 │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘

 ultracode · review-changes · Verify · 3/5 · 12s
   ⠋ review:bugs   ⠋ review:perf   ✗ review:security
```

- The **bottom strip** keeps one line per run under the transcript, with the agent list indented
  underneath; with several runs active it collapses to one summary line per run.
- The **sidebar panel** (`Ctrl-x` then `b`) shows a per-run summary plus one row per agent.
- The **prompt-row status line** puts live status beside the input, so a run is visible even with
  the sidebar closed.

Agents show as `⠋` running, `✓` done, `✗` failed. All three surfaces are served by one shared
poller — one directory pass per second — so having them all open costs one read. Live rendering
exists only because of a workaround for an upstream limitation: opencode 1.18.x never re-renders
external TUI plugin slots after mount (reactive expressions keep their initial value, `Show`/`For`
insertion no-ops), so the surfaces update imperatively via `node.content` + `requestRender()`
(src/tui/index.tsx documents the full constraint).

## Why ultraopen

opencode can already spawn subagents. The trouble is orchestration by prompting: ask one model to
fan out and you get a nondeterministic pile of parallel turns — different every run, unreadable in
review, and lost the moment a turn stalls. ultraopen makes the fan-out a script: short enough to
read in one screen, diffable in review, and replayable after a crash.

This is not a framework. There is no DSL, no server, nothing to deploy — the orchestration layer
is plain JavaScript that runs inside the coding agent you already use.

| | Ad-hoc prompt fan-out | Orchestration frameworks | ultraopen |
| --- | --- | --- | --- |
| Orchestration lives | in the model's head | a graph DSL plus a server | plain JS, inside your agent |
| Runs are reproducible | every run differs | deterministic | deterministic — same script, same flow |
| Recover from a crash | start over | varies | resume; finished agents replay instantly |
| Reviewable | no | partially | the script is a diff like any other |
| Cost to start | none | a new runtime and concepts | a plugin you already installed |

If you need cross-language runtimes, hosted memory, or a standalone server, use a framework.
ultraopen only tries to be the right tool when the work already happens in opencode.

## What you get

- **`workflow` tool** — runs a JavaScript script that fans out across parallel subagents. Scripts
  pass inline or by path (`scriptPath`), and a previous run replays with `resumeFromRunId`.
- **Schema-forced output** — `agent(prompt, { schema })` returns a validated object; invalid
  output retries up to three attempts in the same session.
- **Resume** — `resumeFromRunId` replays unchanged calls instantly; the first edited call and
  everything after it in the same scope runs live. Failed runs keep their partial journal, so a
  resume only redoes the unfinished work.
- **`ultracode` mode** — raises reasoning effort and makes fan-out the default. Four ways in: the
  `ultracode` agent, the keyword, `/ultracode`, or a project config flag.
- **Live progress** — the three TUI surfaces above, served by one shared poller.
- **Safety rails** — a recursion guard (a nested `workflow()` runs one level only), a wall-clock
  deadline per agent, a global concurrency cap, an orphan reaper that releases subagents left by
  a killed server, and retention pruning of finished run directories.

| Global | Behavior |
| --- | --- |
| `pipeline(items, ...stages)` | streams items through stages with no barrier; a stage gets `(prev, item, index)` |
| `parallel(thunks)` | a barrier over an array of thunks; a failing thunk becomes `null` |
| `agent(prompt, opts?)` | spawns a subagent; returns a validated object with `{ schema }`, `null` if nothing usable |
| `phase(title)`, `log(msg)` | progress narration |
| `budget` | `{ total, spent(), remaining() }` output-token ceiling |

<details>
<summary>Engine limits and agent options</summary>

| Limit | Value |
| --- | --- |
| Agents per run | 1,000 |
| Items per `pipeline`/`parallel` call | 4,096 |
| Script size | 512 KiB |
| Concurrency | 1–32 (default 8) |
| Per-agent deadline | 15 min default |

`agent()` accepts `label`, `phase`, `schema`, `model`, `effort`, `agentType`, `isolation`,
`disallowedTools`.

The script `budget` global exists and nested runs share their parent's ceiling, but the top-level
plugin wires no budget total — the hard ceilings are the per-run agent and per-call item caps
above.

</details>

## Install

1. Build:
   ```bash
   bun install && bun run build
   ```
2. Reference it from both config files. TUI plugins are read only from `tui.json`;
   `opencode.json`'s `plugin` array never reaches the TUI runtime.
   ```jsonc
   // opencode.json
   { "plugin": ["/absolute/path/to/ultraopen"] }

   // tui.json  — for the progress display
   { "plugin": ["/absolute/path/to/ultraopen"] }
   ```
   That's it — opencode loads the plugin on next start.
3. An absolute path is classified as a file plugin, which skips the version-compatibility gate,
   so there is no publish step while iterating.
4. Options go through the tuple form — never a new top-level key, which opencode hard-rejects:
   ```json
   { "plugin": [["/path/to/ultraopen", { "concurrency": 8, "ultracode": true }]] }
   ```
   - `concurrency` — global cap on live agents. Default 8, clamped to 1–32, 0 rejected.
   - `ultracode` or `mode: "ultracode"` — enable `ultracode` effort mode. Default off.
   - `agentDeadlineMs` — wall-clock deadline per agent. Default 15 min.
   - `effortPreference` — the effort ladder tried in order. Default
     `["xhigh", "max", "high", "medium", "low"]`.

## Authoring workflows

The full authoring reference lives in this repo at
[skills/workflow-authoring/SKILL.md](./skills/workflow-authoring/SKILL.md): the globals table,
the engine-enforced rules, composable patterns (adversarial verify, judge panels,
loop-until-dry), and debugging/resume notes. It ships inside the installed package too, so the
model driving your workflow sees the same reference.

The essentials: `meta` must be the first statement and a pure object literal (`name` and
`description` required); the engine rejects `Date.now()`, `Math.random()`, and other
resume-breaking constructs at parse time; pass `dryRun: true` to the tool call for a zero-cost
shape check with `agent()` stubbed. Every run persists its journal, manifest, and result under
the opencode tool-output dir (`ultraopen/<runId>/`) — read `journal.jsonl` to see each agent's
recorded value.

## Compatibility and known limits

Verified against opencode 1.18.29 by the live e2e suites (`test/e2e`).

Working end to end:

- parallel and pipeline fan-out
- schema-forced structured output
- per-model effort resolution
- resume across processes (journal replay returns the recorded values)
- nested `workflow({ script })`
- the per-agent deadline option
- all four ultracode activation surfaces
- the three TUI progress surfaces

Known gaps the e2e probes confirmed:

- the named-workflow form of `workflow()` always throws (`context.named` is never populated —
  pass `{ script }` inline)
- `agent()`'s `isolation: "worktree"` option is inert in the live wiring (`worktreeRoot` is
  never passed)

Each probe carries a `bun run check`-clean implementation note in the suites.

Cosmetic limitations (upstream): the transcript renderer echoes a tool call's raw arguments, so
a `workflow` call displays its full script; the failed-agent glyph shares its line's muted color
instead of the error color (single-node imperative rendering); and an open sidebar renders one
blank line when no runs are active (same single-node imperative rendering). The progress
surfaces (strip, sidebar, prompt status) are where live state shows.

## Development

```bash
bun run check   # lint + strict typecheck + tests (95% coverage gate) + Node parity
bun run m0      # provider smoke test against a live model

bash test/e2e/technical.sh   # live end-to-end: real opencode processes, real model calls
bash test/e2e/visual.sh      # live TUI in tmux: all three progress surfaces, permission flow
bash test/e2e/tui-dev.sh     # run `opencode` locally with the TUI plugin actually rendering
```

The e2e suites run in an isolated scratch XDG home (real provider auth, throwaway state) and
assert on the plugin's own on-disk run artifacts plus captured tmux panes. They make real model
calls — pennies per run on Together. Re-run on flakes: live turns occasionally stall or hit
transient provider errors, and both suites retry the common cases.

`tui-dev.sh` exists because of an upstream dev-checkout trap: the TUI host injects its own
Solid/OpenTUI instances into a plugin only when the plugin directory cannot resolve them, and
`node_modules/solid-js` ships Solid's SSR build under the `node` export condition — signals never
update, and the progress surfaces silently render nothing. A published install doesn't ship
`node_modules` and is unaffected; a dev checkout must stash the shadowing packages (the wrapper
does it for you).

`bun run m0` is a re-runnable health check for the one interaction that cannot be verified from
source: that `format: {type:"json_schema"}` works together with a high reasoning variant, and that
forced tool choice still leaves an agent free to research first. Upstream has no test coverage for
that path, so it can regress silently in an opencode release.

CI runs lint, typecheck, the coverage-gated tests, and Node parity on ubuntu and macOS. The badges
up top are per-workflow: **Coverage** goes red exactly when coverage drops below the 95% gate in
bunfig.toml; **Security** is a weekly zizmor audit of the workflow files themselves (CodeQL needs
a public repo or paid GitHub Code Security, and this repo is private); **Lint** is its own
workflow only because GitHub Actions badges are per-workflow.

## License

MIT — see [LICENSE](./LICENSE). Attribution for the adapted workflow tool description lives in
[NOTICE](./NOTICE).