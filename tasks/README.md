# Task directory

This directory holds the plan for the parity work on ultraopen. The goal is to close the gap between ultraopen and the Claude Code design for the `workflow` tool and the `ultracode` mode. The source is a review from 2026-09-12 that listed 12 confirmed differences and ranked them.

An epic is a group of related tasks that ships as one unit. Each epic folder holds a spec and a notes folder.

## Folder structure

```
tasks/
  README.md            this file
  <epic>/
    SPEC.md            the product summary, the UX acceptance criteria, and the technical acceptance criteria
    notes/
      <topic>.md       one file per item that the implementer must remember
```

## How to work

1. Read `SPEC.md` of the epic. Then read every file in `notes/`. The notes hold facts about the code and the design that the spec does not repeat.
2. Pick one task from the task list. Tasks in one epic can run in parallel when they touch different files. Each task names its files. Tasks that touch the same file run in sequence.
3. Make the smallest change that works. Keep `bun run check` green. The coverage gate needs 95 percent, so every change carries tests.
4. When you learn something that later tasks must know, write it in a new notes file. One topic per file. Write in simple English.
5. Update the Status line in `SPEC.md` when you start and when you finish.

## Rules for acceptance criteria

Every acceptance criterion must be mechanically and deterministically verifiable. A criterion names its proof:

- UX criteria: a frame capture in `test/e2e/visual.sh`, or an integration test in `test/e2e/technical.sh`, or a design mockup for pure layout work.
- Technical criteria: a unit test, an integration test, or an end-to-end test at the right level.

Each spec holds positive criteria (something works) and negative criteria (an anti-pattern does not happen).

## Epics

| Epic | Covers review items | Estimate |
| --- | --- | --- |
| `async-runs` | 1. Background runs instead of a blocking tool call | 3 to 5 days |
| `safety-rails` | 2. Activity-based deadline. 5. Cost guardrails. 6. Approval parity | 3.5 to 6 days |
| `run-control` | 7. In-run steering. 10b. Keyboard resume. 11. Progress detail | 9 to 12 days |
| `reliability-ux` | 8. Failure display. 9. Crash recovery | 2 to 3 days |
| `workflow-reuse` | 3. Named workflows. 10a. Resume command | 1.5 to 2.5 days |
| `keyword-semantics` | 4. One-shot keyword and path filter | 0.5 to 1 day |
| `upstream-fixes` | 12. Transcript echo fix in opencode core | 1 to 2 days, upstream |

Estimates assume an implementer who knows this repository. Each estimate includes tests, the coverage gate, and documentation.

## Sequencing

The quick wins are `keyword-semantics`, the deadline work in `safety-rails`, `workflow-reuse`, and the display work in `reliability-ux`. The large item is `async-runs`. The budget wiring in `safety-rails` lands with `async-runs`, because a runaway background run is the most expensive failure. `run-control` needs the control channel first, and its keyboard resume depends on the TUI selection work.

## Branch

The work runs on branch `phillip/epics-planning`. Rename the branch to `username/TICKET-ID-description` before the first merge request, when a ticket id exists.