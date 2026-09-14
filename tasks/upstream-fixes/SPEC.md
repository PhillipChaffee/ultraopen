# Epic: upstream-fixes

Status: not started
Estimate: 1 to 2 focused days, in the opencode repository
Depends on: nothing in this repo, except the README note

## Summary

opencode prints the raw arguments of every tool call in the transcript. A `workflow` call carries the whole script, so the transcript shows the full script text. The README lists this as a cosmetic upstream limitation. The fix lives in opencode core, not in this plugin.

This epic is an upstream contribution: collapse long tool arguments in the transcript, with an expand action. The plugin-side work is one README note and, if the metadata gap from the approval epic is real, a second upstream item.

From the user experience view: the transcript stays readable. The script renders as one line with a length note, and the reader can expand it when needed.

## UX acceptance criteria

Positive:

- UX: The transcript shows the first line of long tool arguments plus a note with the length. Proof: frame capture in the opencode e2e flow with a long `workflow` call.
- UX: The reader can expand the collapsed arguments and see the full text. Proof: frame capture after the expand action.
- UX: The copy path still works. The reader can copy the full arguments, collapsed or expanded. Proof: manual check recorded in the PR description, plus a render unit test.

Negative:

- UX: Short arguments render exactly as today. Proof: render test with a small tool call.
- UX: Tool results are not collapsed. Only the input arguments are. Proof: render unit test.
- UX: ultraopen behavior does not change. Proof: the full ultraopen test suite stays green with no plugin change.

## Technical acceptance criteria

Positive (in opencode core):

- Unit: the renderer truncates argument text over a threshold and marks the truncation with the full length.
- Unit: the expand action restores the full text without a re-fetch.
- Test: the transcript render for a tool call with a 512 kilobyte argument stays within the render budget. A frame or a timing assertion.

Negative:

- No behavior change in ultraopen. The epic ships no plugin code except a README note.
- The upstream change must not alter what reaches the model. The collapse is display only. A test makes sure that the message payload keeps the full text.

## Task list

- [ ] T1 Research the render path in opencode core. Find the tool-call render code and the right place for the collapse. Record the finding in the notes. Estimate 0.5 day.
- [ ] T2 Upstream PR with tests. Estimate 1 to 2 days.
- [ ] T3 README note in ultraopen that states the upstream status. Files: `README.md`. Estimate 0.25 day.