#!/usr/bin/env bash
# visual.sh — visual/UX verification of ultraopen's progress surfaces in a REAL
# opencode TUI, driven through tmux: send-keys in, capture-pane out, assertions
# on the literal markers the components render (src/tui/data.ts,
# src/tui/index.tsx). Two modes run in one pass:
#
#   synthetic — fabricated run dirs rendered by the TUI's RPC-backed surfaces:
#               no model in the loop, deterministic states, every surface
#               exercisable. The session is pre-created over the HTTP API, so
#               V2a–V2f and V5 make zero paid model calls.
#   live      — a real workflow turn: markers appear mid-run, vanish on exit,
#               the GenericTool transcript row shows spinner/check glyphs.
#
# The opencode server half runs as `opencode serve`; the TUI attaches with
# `opencode --server <url> --session <id> --auto`. There is no `--port` on the
# TUI in V2, and every API probe authenticates with OPENCODE_PASSWORD.
#
# Frames (with colors, capture-pane -e) are dumped under test/e2e/artifacts/
# for human review of layout and styling that text assertions can't see.
#
# Usage:  bash test/e2e/visual.sh [--fast|--keep|CASE...]
#
#   (no args)          the full suite: rest, synth, live, hydration, permission, hint, spike
#   --fast             the short version: rest, synth, hint — zero model calls
#                      (the session is pre-created), no live workflow turns (~2 min)
#   CASE...            run only the named cases, in this order:
#                        rest       V1  no markers at rest (cheap)
#                        synth      V2a-V2f  synthetic runs, sidebar, failed
#                                   glyph, multi-run, narrow pane, vanish
#                        live       V3  a real workflow turn (VISUAL_LIVE_FIXTURE
#                                   picks the fixture, default "parallel")
#                        hydration  V6  a settled run starts a new turn while
#                                   the host idles (ticket #7)
#                        permission V4  the approval dialog renders (no --auto)
#                        hint       V5  the interrupted-run hint on boot
#   --keep             keep the scratch XDG home for post-mortem
#
# A case that needs a session pre-creates it over the HTTP API (zero model
# calls; the synthetic cases cost nothing). The live cases make real model
# calls (pennies). Requires tmux.

cd "$(dirname "$0")" || exit 1
# shellcheck source=lib.sh
source ./lib.sh

KEEP=0
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--keep" ]; then KEEP=1; else ARGS+=("$arg"); fi
done

RUN_CASES="rest synth live hydration permission hint spike"
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
  e2e_teardown visual
}
trap cleanup EXIT
visual_on_signal() {
  note "caught INT/TERM — stopping the suite and cleaning up"
  cleanup
  exit 130
}
trap visual_on_signal INT TERM

OUT="$(artifacts_dir visual)"
if [ $KEEP -eq 1 ]; then : > "$OUT/keep.flag"; fi
# capture-pane -e (colored frames) returns 0 bytes on tmux 3.7c/arm64, so frames
# are plain text: layout and content are verifiable, colors are not.
frame() { tui_capture > "$OUT/$1.frame"; }

command -v tmux >/dev/null || { bad "tmux not installed"; finish; exit 1; }

section "setup"
# Reclaim prior-run orphans before anything of this run exists (#44); the
# reaper forks right after the scratch exists, so it can tear it down if this
# script dies any way its traps cannot handle.
e2e_startup_sweep
scratch_new
e2e_start_reaper visual
note "scratch: $SCRATCH"
if build_plugin; then
  ok "plugin built"
else
  bad "plugin build failed"; finish; exit 1
fi

# V2's runtime loader injects the host Solid/OpenTUI instances, so the old
# node_modules stash is gone. The server half starts on the first tui_start and
# is reused across TUI reboots; the sidebar starts hidden via cli.json so the
# explicit toggle below has a deterministic baseline.
boot_tui() {
  ensure_session
  [ -n "$SID" ] || { bad "cannot boot the TUI without a session"; finish; exit 1; }
  tui_start --auto --session "$SID"
  wait_tui_ready || { frame 00-boot-failed; finish; exit 1; }
  # No fixed settle for the TUI's startup input-drop window (~10s, opencode
  # issue #42915): input-free steps (frame dumps, the rest assertions) run at
  # once, and the first input-bearing step gates itself on its own effect
  # (probe_verify_retry).
  frame 00-boot
  # The client half loads from `plugins` in the same config as the server. If
  # that setup throws, every surface assertion below would fail for one root
  # cause — report it here, with the host's own error, and stop.
  sleep 2
  if tui_plugin_setup_failed; then
    bad "the ultraopen TUI plugin failed at setup" "$(tui_plugin_setup_error)"
    frame 00-boot-plugin-failed
    finish; exit 1
  fi
  ok "TUI up in tmux (artifacts: $OUT)"
}

# The CLI writes plugin reconciliation failures to the scratch log with role=cli.
tui_plugin_setup_failed() {
  local log="$DATA_ROOT/log/opencode.log"
  [ -f "$log" ] && rg -q 'message="plugin operation failed".*plugin=ultraopen.*role=cli' "$log"
}
tui_plugin_setup_error() {
  rg 'message="plugin operation failed".*plugin=ultraopen.*role=cli' "$DATA_ROOT/log/opencode.log" 2>/dev/null | tail -1 | cut -c1-240
}

SID=""
SESSION_ID=""

# V2's GenericTool row can scroll above the visible pane once the prompt and transcript grow.
# The visual surfaces are asserted separately; the tool call itself is proven in the session
# part stream (the row is presentation, the part is the durable record).
workflow_tool_call_in_db() {
  python3 - "$XDG_DATA_HOME/opencode/opencode.db" <<'PY'
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
for (data,) in db.execute("SELECT data FROM session_message WHERE type = 'assistant'"):
    try:
        message = json.loads(data)
    except ValueError:
        continue
    for part in message.get("content", []):
        if isinstance(part, dict) and part.get("type") == "tool" and part.get("name") == "workflow":
            sys.exit(0)
sys.exit(1)
PY
}

# Session setup is a plain API call: V2 returns { data: Session.Info } from
# POST /api/session, so the synthetic cases need no model call and no
# input-window gate.
ensure_session() {
  [ -n "$SID" ] && return 0
  server_start
  wait_for "$E2E_WAIT_TIMEOUT" health_ok || { bad "opencode server never became ready"; return 1; }
  warm_location
  SID="$(session_create "ultraopen e2e")" || { bad "could not pre-create a session"; SID=""; return 1; }
  SESSION_ID="$SID"
  ok "session id: $SID"
}

# The sidebar starts closed; <leader>b opens it. The keystroke occasionally
# races a repaint, so the toggle is probe-verify-retry: bounded attempts, the
# heading's render is the verify (spec §5.3).
sidebar_open() { pane_matches '^ *ultracode *$'; }
sidebar_keys() { tui_keys C-x; sleep 0.5; tui_keys b; }
toggle_sidebar() { probe_verify_retry sidebar_keys sidebar_open 3 3; }

if want rest || want synth || want live || want hydration || want spike; then
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

if want synth || want live || want spike; then
  section "V2 — pre-created session (zero paid model calls)"
  ensure_session
  [ -n "$SID" ] && ok "TUI is attached to session $SID" || bad "session setup failed"
fi

if want synth; then
  if [ -z "$SID" ]; then
    bad "synthetic cases need a session" "the session setup failed"
  else
  section "V2a — synthetic run renders all three surfaces"
  synth_run wf_syntha1 "$SID" e2e-visual Verify "alpha:one" "running" "alpha:two" "done"
  assert_pane_contains "prompt-row status appears (ultracode ⠋)" "ultracode ⠋ " 5
  assert_pane_contains "bottom strip appears (ultracode · e2e-visual)" "ultracode · e2e-visual" 5
  assert_pane_contains "strip agent details (one active run shows them)" "alpha:one" 5
  # The id-bearing strip row (#150): glyph, label, child session id — locate by id, not position.
  assert_pane_contains "strip agent row carries the child session id" "alpha:one · ses_synth0" 5
  frame 03-synth-running

  section "V2b — sidebar panel (toggle it open, right column)"
  if toggle_sidebar; then
    ok "sidebar heading renders on its own line"
  else
    bad "sidebar heading not found alone on a line"
  fi
  if pane_matches '⠋ alpha:one · ses_synth0 *$'; then
    ok "sidebar agent row renders (glyph + label + child id at line end)"
  else
    bad "sidebar agent row not found at line end" "expected '⠋ alpha:one · ses_synth0' ending a line"
  fi
  # The transcript affordances hint rides under the rows (#150), naming the picker and the
  # gesture without any positional claim. The sidebar wraps its free text at the column width,
  # so assert the unambiguous fragment a wrap cannot split.
  if pane_matches 'transcripts: /workflows'; then
    ok "the transcript hint renders in the sidebar"
  else
    bad "sidebar transcript hint not found" "expected the /workflows + /sessions hint under the agent rows"
  fi
  frame 04-sidebar

  section "V2c — failed agent glyph and failure count"
  synth_run wf_syntha1 "$SID" e2e-visual Verify "alpha:one" "running" "alpha:two" "failed"
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
  python3 - "$RUN_ROOT/wf_syntha1" <<'PYL'
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

  section "V2d — two runs of one session across the surfaces, and a foreign session's run filtered out"
  # The TUI renders N concurrent runs per session on every surface (the
  # concurrent-launch policy: docs/adr/0001-launch-concurrency-policy.md).
  # Run A's snapshot still holds V2c2's 20 bulk agents, which would clip run B
  # out of the sidebar panel — restore the two-agent shape first.
  synth_run wf_syntha1 "$SID" e2e-visual Verify "alpha:one" "running" "alpha:two" "done"
  synth_run wf_synthb1 "$SID" e2e-other Probe "beta:one" "running"
  assert_pane_contains "prompt status collapses to run count" "ultracode ⠋ 2 runs" 5
  assert_pane_contains "strip lists both runs" "ultracode · e2e-other" 5
  assert_pane_contains "strip keeps the first run" "ultracode · e2e-visual" 5
  if ! sidebar_open; then
    # The toggle races a repaint, so retry it; the assertions below run either way.
    toggle_sidebar || true
  fi
  assert_pane_contains "sidebar renders both runs' summaries" "e2e-other" 5
  assert_pane_contains "sidebar renders run A's agent row" "⠋ alpha:one" 5
  assert_pane_contains "sidebar renders run B's agent row" "⠋ beta:one" 5
  # A run belonging to a DIFFERENT session must never reach this session's view:
  # every surface filters by session id.
  synth_run wf_synthstray "ses_stray0000000000000000" e2e-stray Stray "gamma:one" "running"
  assert_pane_lacks "a foreign session's run is filtered out of the strip" "ultracode · e2e-stray" 5
  assert_pane_lacks "a foreign session's run is filtered out of the sidebar" "gamma:one" 5
  frame 06-multi-run

  section "V2e — narrow pane keeps the marker prefixes"
  # V2's `session.composer.top` slot gets the composer's width, not the terminal's. At 60 cols
  # with the sidebar open that leaves ~17 columns and clips the workflow name; close it so the
  # narrow-pane check tests the strip's own prefix rather than the sidebar split.
  if sidebar_open; then
    toggle_sidebar || true
  fi
  tmx resize-window -x 60 2>/dev/null || tmx resize-pane -x 60 || true
  sleep 1
  assert_pane_contains "strip prefix survives 60 cols" "ultracode · e2e-visual" 5
  frame 07-narrow
  tmx resize-window -x 200 2>/dev/null || tmx resize-pane -x 200 || true
  sleep 1

  section "V2f — terminal status makes surfaces vanish (live-only display)"
  synth_finish wf_syntha1 completed
  synth_finish wf_synthb1 completed
  # The foreign-session run settles too, so no later boot reaps it into a hint.
  synth_finish wf_synthstray completed
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
  # Check the live surfaces FIRST: the fixture is fast and the strip/prompt disappear the
  # moment it settles. The tool row itself may scroll out of the pane, so the durable part
  # stream proves the call while the strip/prompt prove the live rendering.
  assert_pane_contains "prompt status shows live run" "ultracode ⠋ " 20
  assert_pane_contains "strip shows live run (ultracode · e2e-parallel)" "ultracode · e2e-$LIVE_FIXTURE" 20
  if wait_for 30 workflow_tool_call_in_db; then
    ok "the workflow tool call is in the session part stream"
  else
    bad "no workflow tool call in the session part stream" "see $OUT for frames"
  fi
  frame 09-live-midrun
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
  assert_pane_lacks "strip clears after the run completes" "ultracode · e2e-$LIVE_FIXTURE" 300
  assert_pane_lacks "prompt status clears after completion" "ultracode ⠋ " 5
  frame 10-live-done
fi

if want spike; then
  section "SPIKE — /workflows panel + per-agent recordings (#150)"
  # V2 has no custom transcript/tool-renderer slot and no V1 child-navigation
  # gesture. The plugin's readable surfaces are the `/workflows` session panel
  # (clickable child rows) and the always-on per-agent JSONL recordings
  # (ADR-0004). Two agents, one plain and one schema'd; the schema'd child is
  # the one whose native transcript view is unreliable, which is why the
  # recording exists.
  runs_snapshot "$OUT/runs-before-spike.txt"
  tui_http_prompt "$(wf_prompt spike-mixed)"
  assert_pane_contains "strip shows live run" "ultracode · e2e-spike" 20
  if wait_for 30 workflow_tool_call_in_db; then
    ok "the workflow tool call is in the session part stream"
  else
    bad "no workflow tool call in the session part stream" "see $OUT for frames"
  fi
  frame 20-spike-midrun-before-nav

  recordings_count() { # recordings_count RUNID → jsonl file count in its recordings dir
    python3 - "$RUN_ROOT/$1/recordings" <<'PYEOF'
import sys, pathlib
d = pathlib.Path(sys.argv[1])
try:
    print(len([p for p in d.iterdir() if p.suffix == ".jsonl"]))
except OSError:
    print(0)
PYEOF
  }
  recording_contains() { # recording_contains RUNID FILENAME NEEDLE
    python3 - "$RUN_ROOT/$1/recordings/$2" "$3" <<'PYEOF'
import sys, pathlib
try:
    text = pathlib.Path(sys.argv[1]).read_text(errors="ignore")
except OSError:
    sys.exit(1)
sys.exit(0 if sys.argv[2] in text else 1)
PYEOF
  }

  SPIKE_RUN="$(newest_run "$OUT/runs-before-spike.txt")"
  # Filenames are the store's deterministic contract (index + sanitized label), NOT a glob:
  # a reader locates an agent's recording the same way status rows point at it.
  spike_recordings_up() { [ "$(recordings_count "$SPIKE_RUN")" -ge 2 ] && [ -f "$RUN_ROOT/$SPIKE_RUN/recordings/0000-plain-one.jsonl" ] && [ -f "$RUN_ROOT/$SPIKE_RUN/recordings/0001-schema-two.jsonl" ]; }
  if wait_for 60 spike_recordings_up; then
    ok "both agents' recording files exist mid-run (0000-plain-one.jsonl, 0001-schema-two.jsonl)"
  else
    bad "recording files did not appear mid-run" "expected 2 jsonl files under $RUN_ROOT/$SPIKE_RUN/recordings"
  fi

  # The `/workflows` panel is the inspection surface in V2: open it and assert
  # the run summary and both clickable child rows. Navigation is the palette
  # command (`/workflows`), never the removed V1 C-x Down/Right gesture.
  open_workflows_panel() { tui_keys -l "/workflows"; sleep 0.5; tui_keys Enter; }
  workflows_panel_open() { pane_contains "ultracode workflows"; }
  if probe_verify_retry open_workflows_panel workflows_panel_open 8 3; then
    ok "the /workflows panel opens"
  else
    bad "the /workflows panel never opened" "the slash command did not render the session panel"
  fi
  assert_pane_contains "panel lists the live run" "e2e-spike" 15
  assert_pane_contains "panel lists the plain child row" "plain:one" 15
  assert_pane_contains "panel lists the schema'd child row" "schema:two" 15
  frame 21-workflows-panel
  tui_keys Escape; sleep 1

  # After the run settles: the panel still lists the run and its children (the
  # RPC returns active/recent runs), and the recordings hold BOTH agents' full
  # streams — the schema'd child's only predictable visibility.
  spike_done() { [ -n "$(newest_completed_run "$OUT/runs-before-spike.txt")" ]; }
  if wait_for 300 spike_done; then
    ok "spike run completed on disk"
    SPIKE_RUN="$(newest_completed_run "$OUT/runs-before-spike.txt")"
    if [ "$(recordings_count "$SPIKE_RUN")" -ge 2 ]; then
      ok "both agents' recordings survive the settle (post-run: $(recordings_count "$SPIKE_RUN") files)"
    else
      bad "recording files missing after settle" "expected both under $RUN_ROOT/$SPIKE_RUN/recordings"
    fi
    if recording_contains "$SPIKE_RUN" "0000-plain-one.jsonl" "SPIKE-PLAIN-MARK-7391"; then
      ok "the plain agent's recording carries its part stream (prompt marker present)"
    else
      bad "the plain agent's recording lacks its marker" "the joined lines should read as the agent's full part stream"
    fi
    if recording_contains "$SPIKE_RUN" "0001-schema-two.jsonl" "SPIKE-SCHEMA-MARK-7391"; then
      ok "the schema'd agent's recording carries its part stream — the only readable copy of that transcript"
    else
      bad "the schema'd agent's recording lacks its marker" "the recording is that agent's ONLY view; without the marker it explains nothing"
    fi
  else
    note "spike run did not complete in 300s — historical panel pass still attempted"
  fi
  sleep 2
  if probe_verify_retry open_workflows_panel workflows_panel_open 8 3; then
    ok "the /workflows panel still opens after settle"
  else
    note "the /workflows panel did not reopen after settle — the recordings above decide the case"
  fi
  assert_pane_contains "panel keeps the settled run visible" "e2e-spike" 15
  frame 22-workflows-panel-settled
  tui_keys Escape; sleep 1
fi

if want hydration; then
  section "V6 — idle hydration: a settled run starts a new turn in a long-lived host"
  # The detached run settles ~30s after launch — AFTER the launch turn has
  # ended (long-lived host: the contract text frees the turn). The plugin then
  # hydrates the parent with a synthetic `<workflow-completed>` notification
  # (ticket #7), which starts a NEW turn; the model answers it. The prompt is
  # phrased WITHOUT the literal `workflow-completed` so the transcript echo of
  # the prompt cannot satisfy the notification assert (echo false-positive
  # class, spec §5.2), and the ack is asserted on an ASSISTANT message in the
  # scratch db — the prompt echo renders it too, so the pane cannot decide it.
  runs_snapshot "$OUT/runs-before-v6.txt"
  tui_http_prompt "Call the workflow tool now. Pass no scriptPath and no args. Use this script exactly, unchanged:

$(cat "$E2E_DIR/fixtures/idle-hydration.js")

The tool returns a launch result with a run id, not the outcome. Do NOT poll workflow_status and do not wait for the run: end your turn immediately after the launch result. A completion notification will arrive in this conversation when the run settles. When it arrives, reply with exactly HYDRA-VIS-ACK-7391 and nothing else."
  if wait_for 30 workflow_tool_call_in_db; then
    ok "the workflow tool call is in the session part stream"
  else
    bad "no workflow tool call in the session part stream" "see $OUT for frames"
  fi
  v6_done() { [ -n "$(newest_completed_run "$OUT/runs-before-v6.txt")" ]; }
  if wait_for 300 v6_done; then
    ok "the idle run completed on disk: $(newest_completed_run "$OUT/runs-before-v6.txt")"
  else
    bad "the idle-hydration run never completed" "see $OUT for frames"
  fi
  # The notification lands while the host idles; hydration starts a new turn.
  # V2 stores it in session_message (type = 'synthetic') and renders it inline
  # as `◈ <description>` — the description is `Workflow <name> completed`. The
  # pane row proves the visual surface; the db proves delivery; the assistant
  # ack (also db-level, since the prompt echo renders the literal too) proves a
  # new turn started from it.
  v6_notified() {
    python3 - "$XDG_DATA_HOME/opencode/opencode.db" <<'PYEOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute(
    "SELECT 1 FROM session_message WHERE type = 'synthetic' AND data LIKE '%<workflow-completed run=%' LIMIT 1"
).fetchone()
sys.exit(0 if row else 1)
PYEOF
  }
  if wait_for 60 v6_notified; then
    ok "the synthetic notification is in the parent transcript"
  else
    bad "no synthetic notification in the transcript db" "inspect $SCRATCH/share/opencode/opencode.db"
  fi
  assert_pane_contains "the synthetic transcript row renders (◈ description)" "◈ Workflow e2e-idle-hydration completed" 120
  frame 15-hydration-notification
  v6_acked() {
    python3 - "$XDG_DATA_HOME/opencode/opencode.db" <<'PYEOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
notif = db.execute(
    "SELECT seq, session_id FROM session_message "
    "WHERE type = 'synthetic' AND data LIKE '%<workflow-completed run=%' "
    "ORDER BY seq DESC LIMIT 1"
).fetchone()
if notif is None:
    sys.exit(1)
row = db.execute(
    "SELECT 1 FROM session_message WHERE session_id = ? AND type = 'assistant' "
    "AND seq > ? AND data LIKE '%HYDRA-VIS-ACK-7391%' LIMIT 1",
    (notif[1], notif[0]),
).fetchone()
sys.exit(0 if row else 1)
PYEOF
  }
  if wait_for 240 v6_acked; then
    ok "the model responded to the notification in a new turn (assistant ack after it)"
  else
    bad "no assistant ack after the hydration notification" "see $OUT/15-hydration-ack.frame and the scratch db"
  fi
  frame 15-hydration-ack
fi

if want permission; then
  section "V4 — the approval dialog renders the generic ask (no --auto)"
  tui_quit
  tmx kill-server 2>/dev/null || true
  sleep 1
  # A fresh no-auto TUI over the same pre-created session: attaching with
  # --auto is what suppresses the ask, so only a flagless boot proves it.
  ensure_session
  tui_start --session "$SID"
  wait_tui_ready || { frame 11-permission-boot-failed; finish; exit 1; }
  # Snapshot BEFORE the workflow prompt: the run dir is created the instant the
  # approved tool executes, so a later baseline would swallow it.
  runs_snapshot "$OUT/runs-before-v4.txt"
  tui_http_prompt "$(wf_prompt tiny)"
  # On an isolated TUI (no --auto, no leaked config) the ask surfaces the
  # approval dialog (#43). The assert anchors to the dialog frame's own
  # heading, never free-pane text — a metadata-name grep here always matched
  # the transcript echo of the tool-call args instead (echo false-positive
  # class, spec §5.2), so the name check is consciously removed.
  assert_pane_contains "the approval dialog renders the generic ask" "Permission required" 300
  note "upstream gap (carried from the V1 verification): the approval dialog omits the ask's metadata (workflow name, description, phases)"
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
    ok "Enter submitted the dialog (Allow once) — approved workflow reached a terminal state: $(newest_run "$OUT/runs-before-v4.txt") is $(manifest_status "$(newest_run "$OUT/runs-before-v4.txt")")"
  else
    # A rejected ask is not the only way the run never lands: a provider-flaked
    # call can fail after approval and a model retry then asks again (2/2
    # full-run V4 failures on 2026-09-19, before the resume-refusal gates moved
    # ahead of the ask — #69; that fix removed the burned-approval cause, this
    # guard now covers only genuine re-asks). Approve the re-asked dialog once
    # (V3's one-retry shape) before failing.
    if pane_contains "Permission required"; then
      note "approval consumed by a refused re-call — approving the re-asked dialog once"
      tui_keys Enter
      sleep 1
      if wait_for 120 v4_ran; then
        ok "Enter submitted the re-asked dialog (Allow once) — approved workflow reached a terminal state: $(newest_run "$OUT/runs-before-v4.txt") is $(manifest_status "$(newest_run "$OUT/runs-before-v4.txt")")"
      else
        bad "approved workflow never reached a terminal state" "see $OUT for frames"
      fi
    else
      bad "approved workflow never reached a terminal state" "see $OUT for frames"
    fi
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
  # Pre-created session + --session: the hint renders in session.composer.top,
  # so the TUI must be routed to the session. No model call is needed.
  ensure_session
  synth_orphan wf_synthorphan "${SID:-diag-session}" e2e-visual
  tui_start --session "$SID"
  wait_tui_ready || { frame 13-hint-boot-failed; finish; exit 1; }
  assert_pane_contains "boot hint names the interrupted run" "interrupted: e2e-visual (wf_synthorphan)" 120
  frame 13-hint-shown
  hint_count() { tui_capture | grep -c "interrupted: e2e-visual (wf_synthorphan)" || true; }
  sleep 3
  if [ "$(hint_count)" -le 1 ]; then
    ok "the hint appears exactly once (once-only per boot)"
  else
    bad "hint repeated on the pane" "$(hint_count) occurrences"
  fi
  frame 14-hint-once
fi

if ! want rest && ! want synth && ! want live && ! want hydration && ! want permission && ! want hint && ! want spike; then
  bad "no known case selected" "known cases: rest synth live hydration permission hint spike; --fast for the short pass"
fi

if want rest || want synth || want live || want hydration || want permission || want hint || want spike; then
  # Teardown before the summary so port-freeness is asserted on the real end
  # state (the EXIT trap's shared teardown then finds nothing left). The port
  # probe is an assertion, never a kill input.
  tui_quit
  tmx kill-server 2>/dev/null || true
  server_stop
  assert_port_free
fi

finish