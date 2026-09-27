# opencode Discord message (draft v2)

**Venue notes (from research/opencode-plugin-venues.md §8):** the server (85.9k members) exposes
only two channels to non-members; the announcement channel and its etiquette need a human join
step before this posts. Don't guess a channel name. Chat register: one message, no headers,
light markdown. Nothing here should post until the v0.1.0 release is actually cut and proven
installable (#111).

---

Just cut ultraopen 0.1.0: multi-agent workflows for opencode, written as plain JS scripts. You write a short script where `agent()` is the only nondeterministic call and everything else (fan-out, loops, thresholds) is real code, so runs are reproducible. The run goes in the background with live status and a notification when it settles, and resume replays finished agents from the journal instead of re-running them.

Install: `opencode plugin ultraopen -g` (needs opencode 1.18.20+)

Repo with a longer intro and TUI screenshots: https://github.com/PhillipChaffee/ultraopen

if the workflow tool's shape looks familiar, that's on purpose. NOTICE names the ancestor. MIT, though.