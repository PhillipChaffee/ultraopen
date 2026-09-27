# X thread (draft v4)

**Venue notes:** X has no submission mechanics (research §9), so this is just a well-sized
thread. Each tweet under 280 characters. Hashtags left off on purpose; add one if you want.
Images to attach: tweet 3 gets `assets/screenshots/01-invoking.png` (fan-out starting) or
`assets/screenshots/03-sidebar.png` (the panel up close). Nothing here should post until the
v0.1.0 release is actually cut and proven installable (#111). Phillip currently does not plan
to post this (no X audience); it stays in the set because the charting locked three venues, but
say the word and it gets ruled out instead.

---

1/

opencode agents can already spawn subagents. The fan-out lives in the model's head, though: ask for parallel work and every run comes out different, and a stall at turn 40 means starting over.

2/

ultraopen (new plugin, v0.1.0) makes the orchestration a plain JS script. `agent()` is the only nondeterministic call in it. Loops, fan-out, thresholds, early exit: real code. Same script, same flow, reviewable like any diff.

3/

[attach screenshot]

Four review agents spawn in parallel, one row per agent in the TUI. A second wave verifies their findings by execution.

4/

Runs go in the background. `workflow_status` reads live state from disk, and a notification lands in the conversation when the run settles. If a run dies, resume replays finished agents from the journal instead of re-running them.

5/

Install is one command: `opencode plugin ultraopen -g` (needs opencode 1.18.20+). MIT. Repo, with a longer intro and the full feature list: https://github.com/PhillipChaffee/ultraopen