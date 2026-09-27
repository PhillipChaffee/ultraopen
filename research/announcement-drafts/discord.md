# opencode Discord message (draft v4)

**Venue notes:** Phillip joined the server (2026-09-27); the full channel list is now known.
Plugin announcements belong in **#community-projects** (user-made plugins and projects).
#announcements and #releases are official broadcast channels, not for member posts. Before
posting: read #rules once and eyeball recent posts in #community-projects for format. Chat
register: one message, no headers, light markdown. Nothing here should post until the v0.1.0
release is actually cut and proven installable (#111).

---

Just cut ultraopen 0.1.0: multi-agent workflows for opencode, written as plain JS scripts. You write a short script where `agent()` is the only nondeterministic call and everything else (fan-out, loops, thresholds) is real code, so runs are reproducible. The run goes in the background with live status and a notification when it settles, and resume replays finished agents from the journal instead of re-running them.

Install: `opencode plugin ultraopen -g` (needs opencode 1.18.20+)

Repo with a longer intro and TUI screenshots: https://github.com/PhillipChaffee/ultraopen