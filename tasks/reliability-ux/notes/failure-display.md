# Failure display facts

- The failed glyph uses the line color because the render is one imperative node per row. The README lists this under cosmetic limitations, with the single-node imperative rendering as the cause.
- Fix option A: split each sidebar row into two nodes, one for the status glyph with its own color, one for the text with the muted color. Try this first. The render limit note in run-control explains the constraint.
- Fallback: keep one node and prefix the row with a strong text marker plus a count. This is the documented fallback in the spec.
- The nulls list already lands in the tool result (`index.ts`, `renderResult`). The strip count needs live data. Check whether `ProgressWriter` records failures from progress events. If not, add a failure event to the progress file, and the strip reads it. Record the change here.
- The failure reasons live in the journal and in the run result. The sidebar expansion can read them from disk with no new server code.