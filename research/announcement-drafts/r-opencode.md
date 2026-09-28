# r/opencode post (draft v4)

**Venue notes:** Phillip checked the subreddit logged-in (2026-09-27): no subreddit-specific
posting rules are surfaced in the sidebar, About card, or the rules page. Sitewide Reddit rules
(spam, self-promotion) still apply. One thing left to eyeball before posting: open the pinned
"Welcome to the launch of the r/OpenCode subreddit!" announcement once — any posting norms the
mods stated would live there. Nothing here should post until the v0.1.0 release is actually cut
and proven installable (#111).

---

**Title:**

ultraopen v0.1.0: multi-agent workflows for opencode as plain JS scripts (npm plugin)

**Body:**

I've been building ultraopen, a plugin that adds multi-agent workflow orchestration to opencode. v0.1.0 just went up on npm, so install is one command:

    opencode plugin ultraopen -g

(needs opencode 1.18.20 or newer)

The problem it starts from: when you ask an agent to fan out and review five files, the fan-out lives in the model's head. Every run comes out different, and if the run dies at turn 40, you start over. ultraopen makes the orchestration a plain JavaScript script instead. `agent()` is the only nondeterministic call in it; everything else (loops, fan-out, dedup, thresholds, early exit) is real code. Same script, same flow. The script is also a file you can read and review like any other diff.

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

What's in 0.1.0:

- `workflow` runs the script in the background and returns immediately; a `<workflow-completed>` notification lands in the conversation when the run settles
- `workflow_status` reads live run state from disk (phase, agent counts, token spend) and can block one call up to 300s instead of polling
- resume replays finished agents from the journal instead of re-running (and re-billing) them; failed runs keep their partial journal
- `agent(prompt, { schema })` returns a validated object, and bad output retries in-session
- saved workflows run by name, with `/workflow-resume <runId>` to replay a past run
- `ultracode` mode raises reasoning effort and makes fan-out the default
- safety rails: recursion guard, per-agent deadlines, a global concurrency cap, an orphan reaper

In the TUI you get a progress strip plus a sidebar panel (Ctrl-x then b) with one row per agent. The plugin ships the workflow-authoring skill too, so the model driving your workflow reads the same reference you would.

Repo (MIT): https://github.com/PhillipChaffee/ultraopen · npm: https://www.npmjs.com/package/ultraopen

It's a community plugin, not made by the opencode team. If you try it and something breaks, an issue with the run directory attached is the fastest way to get it fixed.