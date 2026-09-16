# Epic: keyword-semantics

Status: done 2026-09-16
Estimate: 0.5 to 1 focused day
Depends on: a design decision, recorded below. The owner approved the reversal on 2026-09-12.

## Summary

Today the keyword `ultracode` turns the mode on for the whole session. A path mention such as `src/ultracode.ts` turns it on too. Claude Code treats the keyword as a one-shot opt-in for one task, and it fires only on input the human typed.

This epic changes ultraopen to a one-shot keyword and stops path matches. The standing mode keeps its two real activation paths: the `ultracode` agent and the `/ultracode` command. The review ranked the sticky keyword as a danger, because one stray mention raises the spend of every later message in silence.

Decision record: `mode.ts` documents the sticky behavior and the path behavior as deliberate choices. The sticky choice made sense when the cost was one turn of raised effort. With the standing fan-out, one stray mention escalates spend in silence, which the review ranked as the top danger. The owner approved the reversal.

From the user experience view: saying `ultracode` fans out that one task, and the next task behaves normally unless you say it again or switch to the mode.

## UX acceptance criteria

Positive:

- UX: A message with the keyword fans out for that task. The next message without the keyword does not fan out by itself. Proof: integration test across two turns.
- UX: A path mention does not turn the mode on. Proof: unit test over a list of path strings.
- UX: The phrase "don't use ultracode" still demotes. Proof: the existing unit test stays green.
- UX: The `/ultracode` command keeps the standing mode for the session. Proof: the existing tests stay green.
- UX: A plugin option selects the keyword behavior, with values `one-shot` and `session`, and the default is `one-shot`. Proof: unit test.

Negative:

- UX: A one-shot keyword leaves no reminder behind. The next turn carries no reminder from the keyword turn. Proof: unit test on the decorate call.
- UX: A word that contains the keyword, such as `ultracoded`, does not trigger. Proof: the existing test.
- Unit: the reminder never accumulates two copies on one message. The existing idempotency test stays green.

## Technical acceptance criteria

Positive:

- Unit: the new regex rejects a match next to path characters. Test table: `src/ultracode.ts` no, `use ultracode to audit` yes, `ULTRACODE` yes with the case-insensitive flag.
- Unit: one-shot mode clears the keyword state after the turn dispatches. Hook test.
- Unit: the `session` value reproduces today's behavior exactly. Characterization test.

Negative:

- Unit: the demote path is untouched by the one-shot change.
- Unit: no state leak between sessions. The existing map-by-session test stays green.
- Unit: the path filter does not reject a keyword at the start or end of a sentence.

## Task list

- [x] T1 Path-aware regex. Files: `src/server/ultracode/mode.ts`. Estimate 0.25 day.
- [x] T2 One-shot state and cleanup. Files: `src/server/ultracode/mode.ts`, `src/server/ultracode/hooks.ts`. Estimate 0.5 day. (Cleanup point: `onChatMessage` expires the keyword state when the NEXT user message arrives — the transform hook re-reads messages every step of the current turn, so the state must survive until the turn's end, and the next chat.message is the exact boundary.)
- [x] T3 Option, docs, and tests. Files: `src/server/options.ts`, `README.md`, `test/ultracode.test.ts`. Estimate 0.25 to 0.5 day.