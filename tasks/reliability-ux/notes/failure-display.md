# Failure display facts

- The failed glyph uses the line color because the render is one imperative node per row. The README lists this under cosmetic limitations, with the single-node imperative rendering as the cause.
- Fix option A: split each sidebar row into two nodes, one for the status glyph with its own color, one for the text with the muted color. Try this first. The render limit note in run-control explains the constraint.
- Fallback: keep one node and prefix the row with a strong text marker plus a count. This is the documented fallback in the spec.
- The nulls list already lands in the tool result (`index.ts`, `renderResult`). The strip count needs live data. Check whether `ProgressWriter` records failures from progress events. If not, add a failure event to the progress file, and the strip reads it. Record the change here.
- The failure reasons live in the journal and in the run result. The sidebar expansion can read them from disk with no new server code.
## Outcome recorded (2026-09-16)

- The rich-text path works at the library level: `@opentui/core`'s
  `TextNodeRenderable` takes per-child `fg` and the parent text renders styled
  chunks. The sidebar rows render into one statically-mounted parent text whose
  children are created AT MOUNT (mount-time imperative construction is fine;
  post-mount reactive insertion is what is broken) and mutated per poll. If any
  of that API drifts, the render flips permanently to the fallback: strong ✗
  markers and the summary's failed count.
- The failed reason comes from the journal (latest null entry per key) and is
  attached to the row at load: `✗ label — reason`. No server code was added.
- The strip's failed count was already rendered by `summarize` from the live
  progress snapshot; the epic's work here was the proof frame.
