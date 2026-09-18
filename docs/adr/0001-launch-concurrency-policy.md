# ADR-0001: Launch concurrency policy

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Phillip Chaffee, with the concurrent-launch design workflow (spec #27)

## Context

The `workflow` tool gates launches per session: one live run, both contracts (`dryRun` exempt).
The refusal was unconditional — even an ultracode session, whose whole point is fanning out, could
not launch a second workflow while an earlier one ground on. The chat stalled behind a single
long fan-out even though the engine, the registries, the per-run disk layout, the status tool and
the TUI already support several concurrent runs.

Three prior facts constrain the decision:

- A same-boot resume of a still-executing run would run two engines against one journal. The
  resume gate defers to the launch-gating registry (`isLiveAnywhere`), so whatever the launch
  policy is, the registry must see every live entry for both contracts (registering blocking
  launches as pending closed that blind spot).
- Demotion ("don't fan out") is process-sticky prompt guidance. It consults nothing deterministic,
  so it cannot gate anything reliably — only guidance the model reads can change.
- The launch contract (`background` vs `blocking`) follows its own config precedence (env kill
  switch > project option > home-dir option > built-in default). It exists to protect one-shot
  hosts that kill the process after the turn.

## Decision

1. **Non-ultracode sessions keep the one-live-run refusal verbatim.** The refusal branch is kept
   verbatim — same text, same trigger. Sessions outside ultracode have no standing fan-out, and a
   second agent-spending run in one session there is still the mixed-contract hazard the gate
   was built for.
2. **Ultracode-active sessions get a live-run cap, not unlimited fan-out.** A session that is
   ultracode-active may hold up to `ultracodeMaxRuns` (new plugin option, default 8, clamped to
   1–32, 0 rejected) live runs across both contracts. A launch below the cap succeeds and its
   result names the sibling live runs; a launch at the cap is refused naming every live run id;
   finishing any run frees a slot. The ceiling exists so a runaway launch loop cannot pile up
   unbounded.
3. **Ultracode-active means the mode singleton's verdict at launch time.** The plugin resolves the
   session's ultracode state via the existing mode singleton combined with the driving agent's
   name, which the host delivers on the tool-execute context (verified against opencode
   1.18.31 — plugin tool contexts carry `agent`). All four activation surfaces are therefore
   covered: the `ultracode` agent, the keyword, `/ultracode`, and the project config flag.
4. **Demotion changes nothing deterministic.** An explicit "don't fan out" instruction reverts
   ultracode's standing opt-in at the prompt level only. The launch gate ignores it entirely: a
   demoted session's explicit workflow launch behaves like any ultracode launch.
5. **Ultracode does not interact with the launch contract.** `background`/`blocking` keeps normal
   config precedence with no ultracode override: the env kill switch still forces blocking, a
   pinned `runMode: "blocking"` is still honored, and ultracode never forces background on a
   session that asked to block.

## Consequences

- An ultracode user can keep launching workflows while earlier ones run; each launch result names
  what else is live, so the model can track and poll each run.
- N concurrent runs each get the full `budgetTokens` ceiling — there is no cross-run rollup.
  Operators should treat the budget as per-run (follow-up ticket #32).
- The gate stays one synchronous step: the refusal check and the pending registration share one
  await-free region, so the check-then-act race cannot admit an at-cap launch.
- `dryRun` remains exempt in both modes: it is free, stubbed, and the standard mid-run debugging
  tool.
- The TUI needs no change: its data layer and all three surfaces already render N runs per
  session; the e2e visual suite asserts it.

## Vocabulary

See `CONTEXT.md` (workflow, run, live run, launch, launch contract, live-run cap, demoted session).