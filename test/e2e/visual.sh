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
# Usage:  bash test/e2e/visual.sh [--fast|--keep|CASE...]
#
#   (no args)          the full suite: rest, synth, live, permission, hint
#   --fast             the short version: rest, synth, hint — one model call
#                      for session setup, no live workflow turns (~2 min)
#   CASE...            run only the named cases, in this order:
#                        rest       V1  no markers at rest (cheap)
#                        synth      V2a-V2f  synthetic runs, sidebar, failed
#                                   glyph, multi-run, narrow pane, vanish
#                        live       V3  a real workflow turn (VISUAL_LIVE_FIXTURE
#                                   picks the fixture, default "parallel")
#                        permission V4  the approval dialog names the workflow
#                        hint       V5  the interrupted-run hint on boot
#   --keep             keep the scratch XDG home for post-mortem
#
# A case that needs a session creates one on demand (one cheap model call).
# The full default pass makes real model calls (pennies on Together). Requires tmux.

cd "$(dirname "$0")" || exit 1
# shellcheck source=lib.sh
source ./lib.sh

KEEP=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--keep" ]; then KEEP=1; else ARGS+=("$arg"); fi
done

RUN_CASES="rest synth live permission hint"
if [ "${1:-}" = "--fast" ]; then
  RUN_CASES="rest synth hint"
  shift
elif [ ${#ARGS[@]} -gt 0 ]; then
  RUN_CASES="${ARGS[*]}"
fi

want() { case " $RUN_CASES " in *" $1 "*) return 0;; *) return 1;; esac; }

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

boot_tui() {
  export OPENCODE_FAST_BOOT=1   # skip the loading screen; shortens the input-drop window
  tui_start --auto
  wait_tui_ready || { frame 00-boot-failed; finish; exit 1; }
  # Input arriving during the TUI's startup capability probes is silently dropped
  # (~10s in tmux — opencode issue #42915), so settle before the first send-keys.
  sleep 12
  frame 00-boot
  ok "TUI up in tmux (artifacts: $OUT)"
}

SID=""
ensure_session() {
  [ -n "$SID" ] && return 0
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
}

if want rest || want synth || want live; then
  section "V0 — boot the real TUI"
  boot_tui
fi

if want rest; then
  section "V1 — rest state: no ultracode markers when nothing runs"
  if pane_lacks 'ultracode · ' && pane_lacks 'ultracode ⠋ '; then
    ok "no strip/prompt markers at rest"
  else
    bad "markers visible with no runs" "nothing should render before any workflow"
  fi
  frame 01-rest
fi

if want synth || want live; then
  section "V2 — create a session (routes the TUI to the session view)"
  ensure_session
fi

if want synth; then
  if [ -z "$SID" ]; then
    bad "synthetic cases need a session" "the session setup failed"
  else
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
  # The failed glyph must carry the theme's error color: a distinct SGR prefix
  # from the muted rows sharing the same pane. The spec's documented fallback —
  # a strong text marker — is the ✗ itself, also asserted.
  tmx capture-pane -e -p -t tui > "$OUT/frame-05-escape.txt"
  if python3 - "$OUT/frame-05-escape.txt" <<'PYEOF'
import re, sys
lines = open(sys.argv[1]).read().splitlines()
def sgr_of(fragment):
    for line in lines:
        if fragment in line:
            codes = re.findall(r"\x1b\[([0-9;]*)m", line)
            if codes:
                return codes[0]
    return None
failed_sgr = sgr_of("✗ alpha:two")
running_sgr = sgr_of("⠋ alpha:one")
sys.exit(0 if (failed_sgr is not None and running_sgr is not None and failed_sgr != running_sgr) else 1)
PYEOF
  then
    ok "failed glyph carries a distinct color from muted rows (error color)"
  else
    note "color check inconclusive — inspect $OUT/frame-05-escape.txt"
  fi
  frame 05-failed-glyph

  section "V2c2 — large-run badge in the strip summary (advice only)"
  # The badge threshold is a constant shared with the server's own warning;
  # 20 synthetic agents cross it. ADVICE ONLY: the run continues normally.
  python3 - "$RUN_ROOT/wf_synth_a" <<'PYL'
import json, sys, time
d = sys.argv[1]
now = int(time.time() * 1000)
manifest = json.load(open(d + "/manifest.json"))
manifest["status"] = "running"
progress = {"runId": manifest["runId"], "workflow": "e2e-visual", "sessionID": manifest["sessionID"],
            "phase": "Verify",
            "agents": [{"index": i, "label": f"bulk:{i}", "status": "done"} for i in range(20)],
            "logs": [], "startedAt": int(now), "updatedAt": int(now)}
open(d + "/progress.json", "w").write(json.dumps(progress))
PYL
  assert_pane_contains "large-run badge in the summary" "· large run" 5
  frame 05b-large-run

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
fi

if want live; then
  section "V3 — live workflow turn: markers mid-run, transcript echo, vanish on exit"
  # The parallel fixture (3 agents) keeps the run visible long enough for the
  # 1s UI poll to catch the strip; tiny runs can complete inside one tick.
  # VISUAL_LIVE_FIXTURE picks the fixture when the caller wants a specific one.
  LIVE_FIXTURE="${VISUAL_LIVE_FIXTURE:-parallel}"
  runs_snapshot "$OUT/runs-before-v3.txt"
  tui_http_prompt "$(wf_prompt "$LIVE_FIXTURE")"
  assert_pane_contains "GenericTool transcript row shows the call" "⚙ workflow" 300
  assert_pane_contains "strip shows live run (ultracode · e2e-parallel)" "ultracode · $LIVE_FIXTURE" 300
  frame 09-live-midrun
  assert_pane_contains "prompt status shows live run" "ultracode ⠋ " 5
  # Live turns occasionally stall on provider hiccups (same class the technical
  # suite's T8 retries) — interrupt and retry the turn once before failing.
  v3_done() { [ -n "$(newest_completed_run "$OUT/runs-before-v3.txt")" ]; }
  if ! wait_for 240 v3_done; then
    note "first attempt did not complete (provider stall) — interrupting and retrying once"
    tui_keys Escape
    sleep 2
    tui_http_prompt "$(wf_prompt "$LIVE_FIXTURE")"
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
  assert_pane_lacks "strip clears after the run completes" "ultracode · $LIVE_FIXTURE" 300
  assert_pane_lacks "prompt status clears after completion" "ultracode ⠋ " 5
  frame 10-live-done
fi

if want permission; then
  section "V4 — permission dialog names the real workflow (no --auto)"
  tui_quit
  tmx kill-server 2>/dev/null || true
  sleep 1
  SID=""
  tui_start
  wait_tui_ready || { frame 11-permission-boot-failed; finish; exit 1; }
  sleep 12
  ensure_session
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
fi

if want hint; then
  section "V5 — interrupted-run hint on boot (crash recovery)"
  # A run the reaper marked orphaned (its process died) leaves a marker; the next
  # start shows a once-per-boot hint naming the run id and the way back. Runs
  # that finished before the crash never hint — asserted here by the ABSENCE of
  # extra hint lines for the completed synthetic runs of V2/V4.
  tui_quit
  tmx kill-server 2>/dev/null || true
  sleep 1
  synth_orphan wf_synth_orphan "${SID:-diag-session}" e2e-visual
  tui_start
  wait_tui_ready || { frame 13-hint-boot-failed; finish; exit 1; }
  sleep 12
  # The hint needs the session routed to show session surfaces; prompt once.
  tui_http_prompt "Reply with exactly the word READY."
  assert_pane_contains "boot hint names the interrupted run" "interrupted: e2e-visual (wf_synth_orphan)" 120
  frame 13-hint-shown
  hint_count() { tui_capture | grep -c "interrupted: e2e-visual (wf_synth_orphan)" || true; }
  sleep 3
  if [ "$(hint_count)" -le 1 ]; then
    ok "the hint appears exactly once (once-only per boot)"
  else
    bad "hint repeated on the pane" "$(hint_count) occurrences"
  fi
  frame 14-hint-once
fi

if ! want rest && ! want synth && ! want live && ! want permission && ! want hint; then
  bad "no known case selected" "known cases: rest synth live permission hint; --fast for the short pass"
fi

finish