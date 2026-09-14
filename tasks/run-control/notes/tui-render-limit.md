# TUI render limit

This is the constraint that shapes every TUI task in this epic and in reliability-ux.

- opencode 1.18.x never re-renders external TUI plugin slots after mount. Reactive expressions keep their first value. `Show` and `For` insertion does nothing. This is an upstream limitation, documented in full in `src/tui/index.tsx`.
- Every surface updates by hand: set `node.content`, then call `requestRender()`. One shared poller drives all three surfaces, one directory pass per second.
- Consequence for selection and keys: each state change rebuilds the affected row text and calls `requestRender`. Selection, expansion, and hover are plain state, not reactive bindings.
- Keyboard events: OpenTUI components can take key events, but the plugin slot's event surface is not proven. Run a spike before task T5: a component that logs keys. Record the finding in this file.
- The failed glyph shares the muted line color because of the same single-node rendering. Splitting a row into a status node and a text node may fix the color. Try it in the reliability-ux epic first, then reuse the pattern here.

Risk statement: all interaction work is hand-built against the render limit. If a future opencode release fixes re-rendering, this epic gets cheaper. Re-check the limitation at the start of task T5 with a one-frame test against the current opencode version.