#!/usr/bin/env bash
# visual.sh — visual/UX verification of ultraopen's three progress surfaces in a
# REAL opencode TUI, driven through tmux: send-keys in, capture-pane out,
# assertions on the literal markers the components render (src/tui/data.ts,
# src/tui/index.tsx). Two modes run in one pass:
#
#   synthetic — fabricated run dirs rendered by the TUI's disk poller: no model
#               in the loop, deterministic states, every surface exercisable.
#   live      — a real workflow turn: markers appear mid-run, vanish on exit,
#               the GenericTool transcript row shows the script echo.
#
# Frames (with colors, capture-pane -e) are dumped under test/e2e/artifacts/
# for human review of layout and styling that text assertions can't see.
#
# Usage:  bash test/e2e/visual.sh [--keep]
# Env:    E2E_MODEL, E2E_WAIT_TIMEOUT, E2E_PORT
# Makes real model calls (pennies on Together). Requires tmux.

cd "$(dirname "$0")" || exit 1
# shellcheck source=lib.sh
source ./lib.sh

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
cleanup() {
  tui_keys C-c 2>/dev/null || true
  sleep 1
  tui_keys C-c 2>/dev/null || true
  tmx kill-server 2>/dev/null || true
  restore_host_modules
  [ $KEEP -eq 1 ] && note "scratch kept: $SCRATCH"
  scratch_destroy
}
trap cleanup EXIT

OUT="$(artifacts_dir visual)"
# capture-pane -e (colored frames) returns 0 bytes on tmux 3.7c/arm64, so frames
# are plain text: layout and content are verifiable, colors are not.
frame() { tui_capture > "$OUT/$1.frame"; }

command -v tmux >/dev/null || { bad "tmux not installed"; finish; exit 1; }

section "setup"
scratch_new
note "scratch: $SCRATCH"
if build_plugin; then
  ok "plugin built"
else
  bad "plugin build failed"; finish; exit 1
fi
stash_host_modules
note "stashed node_modules/{solid-js,@opentui} so the TUI host injects its own instances"

section "V0 — boot the real TUI"
export OPENCODE_FAST_BOOT=1   # skip the loading screen; shortens the input-drop window
tui_start --auto
wait_tui_ready || { frame 00-boot-failed; finish; exit 1; }
# Input arriving during the TUI's startup capability probes is silently dropped
# (~10s in tmux — opencode issue #42915), so settle before the first send-keys.
sleep 12
frame 00-boot
ok "TUI up in tmux (artifacts: $OUT)"

section "V1 — rest state: no ultracode markers when nothing runs"
if pane_lacks 'ultracode · ' && pane_lacks 'ultracode ⠋ '; then
  ok "no strip/prompt markers at rest"
else
  bad "markers visible with no runs" "nothing should render before any workflow"
fi
frame 01-rest

section "V2 — create a session (routes the TUI to the session view)"
SID=""
for attempt in 1 2 3; do
  tui_http_prompt "Reply with exactly the word READY."
  if wait_for 90 session_exists; then
    assert_pane_contains "model replied in-session" "READY" 120
    SID="$(current_session)"
    break
  fi
  note "attempt $attempt: no session appeared — input likely dropped, retrying"
done
if [ -n "$SID" ]; then
  ok "session id: $SID"
else
  bad "could not create a session after 3 attempts"
fi
frame 02-session

if [ -n "$SID" ]; then
  section "V2a — synthetic run renders all three surfaces"
  synth_run wf_synth_a "$SID" e2e-visual Verify "alpha:one" "running" "alpha:two" "done"
  assert_pane_contains "prompt-row status appears (ultracode ⠋)" "ultracode ⠋ " 5
  assert_pane_contains "bottom strip appears (ultracode · e2e-visual)" "ultracode · e2e-visual" 5
  assert_pane_contains "strip agent details (one active run shows them)" "alpha:one" 5
  frame 03-synth-running

  section "V2b — sidebar panel (toggle it open, right column)"
  # The sidebar starts closed; <leader>b opens it. The keystroke occasionally
  # races a repaint, so poll for the content and retry the toggle.
  sidebar_open() { pane_matches '^ *ultracode *$'; }
  for attempt in 1 2 3; do
    tui_keys C-x; sleep 0.5; tui_keys b
    if wait_for 8 sidebar_open; then break; fi
    note "toggle attempt $attempt did not open the sidebar — retrying"
  done
  if sidebar_open; then
    ok "sidebar heading renders on its own line"
  else
    bad "sidebar heading not found alone on a line"
  fi
  if pane_matches '⠋ alpha:one *$'; then
    ok "sidebar agent row renders (glyph + label at line end)"
  else
    bad "sidebar agent row not found at line end" "expected '⠋ alpha:one' ending a line"
  fi
  frame 04-sidebar

  section "V2c — failed agent glyph and failure count"
  synth_run wf_synth_a "$SID" e2e-visual Verify "alpha:one" "running" "alpha:two" "failed"
  assert_pane_contains "failed glyph renders" "✗ alpha:two" 5
  assert_pane_contains "failure count in summary" "· 1 failed" 5
  frame 05-failed-glyph

  section "V2d — multi-run collapse"
  synth_run wf_synth_b "$SID" e2e-other Probe "beta:one" "running"
  assert_pane_contains "prompt status collapses to run count" "ultracode ⠋ 2 runs" 5
  assert_pane_contains "strip lists both runs" "ultracode · e2e-other" 5
  frame 06-multi-run

  section "V2e — narrow pane keeps the marker prefixes"
  tmx resize-window -x 60 2>/dev/null || tmx resize-pane -x 60 || true
  sleep 1
  assert_pane_contains "strip prefix survives 60 cols" "ultracode · e2e-visual" 5
  frame 07-narrow
  tmx resize-window -x 200 2>/dev/null || tmx resize-pane -x 200 || true
  sleep 1

  section "V2f — terminal status makes surfaces vanish (live-only display)"
  synth_finish wf_synth_a completed
  synth_finish wf_synth_b completed
  assert_pane_lacks "prompt-row marker gone after completion" "ultracode ⠋ " 5
  assert_pane_lacks "strip marker gone after completion" "ultracode · e2e-visual" 5
  frame 08-vanished
fi

section "V3 — live workflow turn: markers mid-run, transcript echo, vanish on exit"
# The parallel fixture (3 agents) keeps the run visible long enough for the
# 1s UI poll to catch the strip; tiny runs can complete inside one tick.
runs_snapshot "$OUT/runs-before-v3.txt"
tui_http_prompt "$(wf_prompt parallel)"
assert_pane_contains "GenericTool transcript row shows the call" "⚙ workflow" 300
assert_pane_contains "strip shows live run (ultracode · e2e-parallel)" "ultracode · e2e-parallel" 300
frame 09-live-midrun
assert_pane_contains "prompt status shows live run" "ultracode ⠋ " 5
# Live turns occasionally stall on provider hiccups (same class the technical
# suite's T8 retries) — interrupt and retry the turn once before failing.
v3_done() { [ -n "$(newest_completed_run "$OUT/runs-before-v3.txt")" ]; }
if ! wait_for 240 v3_done; then
  note "first attempt did not complete (provider stall) — interrupting and retrying once"
  tui_keys Escape
  sleep 2
  tui_http_prompt "$(wf_prompt parallel)"
fi
if wait_for 300 v3_done; then
  ok "live run completed on disk: $(newest_completed_run "$OUT/runs-before-v3.txt")"
else
  bad "no completed run dir appeared on disk"
fi
# The model may end its turn with a question dialog, which overlays the strip
# area and freezes its last paint — dismiss before asserting the clear.
tui_keys Escape
sleep 1
assert_pane_lacks "strip clears after the run completes" "ultracode · e2e-parallel" 300
assert_pane_lacks "prompt status clears after completion" "ultracode ⠋ " 5
frame 10-live-done

section "V4 — permission dialog names the real workflow (no --auto)"
tui_quit
tmx kill-server 2>/dev/null || true
sleep 1
tui_start
wait_tui_ready || { frame 11-permission-boot-failed; finish; exit 1; }
sleep 12
tui_http_prompt "Reply with exactly the word READY."
assert_pane_contains "session ready for permission probe" "READY" 300
# Snapshot BEFORE the workflow prompt: the run dir is created the instant the
# approved tool executes, so a later baseline would swallow it.
runs_snapshot "$OUT/runs-before-v4.txt"
tui_http_prompt "$(wf_prompt tiny)"
assert_pane_contains "permission dialog opens" "Permission required" 300
assert_pane_contains "dialog names the workflow (e2e-smoke)" "e2e-smoke" 300
frame 11-permission-dialog
tui_keys Enter   # dialog.select.submit = return -> Allow once
sleep 1
# A warm model finishes the tiny workflow in ~3-5s — faster than the 1s UI
# poll reliably paints, so completion is asserted on the run dir on disk. Any
# terminal state counts: the transient provider api-error (~1 in 3 schema
# calls) fails runs without invalidating what V4 proves — that approval
# unblocked the tool.
v4_ran() {
  local r
  r="$(newest_run "$OUT/runs-before-v4.txt")"
  [ -n "$r" ] && [ "$(manifest_status "$r")" != "running" ] && [ "$(manifest_status "$r")" != "missing" ]
}
if wait_for 300 v4_ran; then
  ok "approved workflow reached a terminal state: $(newest_run "$OUT/runs-before-v4.txt") is $(manifest_status "$(newest_run "$OUT/runs-before-v4.txt")")"
else
  bad "approved workflow never reached a terminal state" "see $OUT for frames"
fi
assert_pane_lacks "strip clears after the approved run" "ultracode · e2e-smoke" 15
frame 12-permission-approved

finish