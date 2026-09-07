#!/usr/bin/env bash
# lib.sh — shared environment for the ultraopen e2e suites.
#
# Isolation: every suite runs inside a scratch XDG home, so sessions, run dirs,
# and logs never touch the developer's real opencode state. Provider auth is
# symlinked in (auth.json lives under $XDG_DATA_HOME/opencode/) so real model
# calls work; everything else is throwaway.
#
# The TUI half resolves the run-data root exactly like the server half
# ($XDG_DATA_HOME else ~/.local/share, then opencode/tool-output/ultraopen),
# so pointing XDG_DATA_HOME at the scratch dir makes the TUI poll the very
# runs this harness creates (src/server/resume/store.ts:27-31, src/tui/data.ts:39-43).
#
# The TUI at opencode 1.18.x only exposes its HTTP server when started with
# --port (otherwise it is an in-process worker), so the visual suite always
# passes --port and readiness-gates on /global/health before sending keys —
# this also dodges the ~10s startup input-drop window (opencode issue #42915).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # absolute: CWD changes after scratch_new
PLUGIN_PATH="$REPO_ROOT"
ARTIFACTS_ROOT="$REPO_ROOT/test/e2e/artifacts"

# Config knobs ----------------------------------------------------------------
E2E_MODEL="${E2E_MODEL:-togetherai/zai-org/GLM-5.3}"
E2E_PORT="${E2E_PORT:-18888}"
E2E_TMUX_SOCKET="${E2E_TMUX_SOCKET:-ultraopen-e2e}"
E2E_WAIT_TIMEOUT="${E2E_WAIT_TIMEOUT:-120}"   # seconds, default for wait_for
E2E_POLL_INTERVAL="${E2E_POLL_INTERVAL:-1}"   # seconds between polls

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31m✗\033[0m %s%s\n' "$1" "${2:+ — $2}"; }
note() { printf '  \033[90m·\033[0m %s\n' "$1"; }
section() { printf '\n== %s ==\n' "$1"; }

finish() {
  printf '\n== summary: %d passed, %d failed ==\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] || exit 1
}

# wait_for TIMEOUT_SECS CMD... — poll CMD until it exits 0. Silent on failure.
wait_for() {
  local timeout="$1"; shift
  local deadline=$((SECONDS + timeout))
  while [ $SECONDS -lt $deadline ]; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep "$E2E_POLL_INTERVAL"
  done
  return 1
}

# Scratch environment ----------------------------------------------------------
SCRATCH=""
DATA_ROOT=""   # $XDG_DATA_HOME/opencode — sessions, auth symlink, run dirs
RUN_ROOT=""    # $DATA_ROOT/tool-output/ultraopen — the plugin's run dirs

scratch_new() {
  SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ultraopen-e2e.XXXXXX")"
  export XDG_DATA_HOME="$SCRATCH/share"
  export OPENCODE_CONFIG_DIR="$SCRATCH/config"
  DATA_ROOT="$XDG_DATA_HOME/opencode"
  RUN_ROOT="$DATA_ROOT/tool-output/ultraopen"
  mkdir -p "$DATA_ROOT" "$OPENCODE_CONFIG_DIR" "$SCRATCH/project"

  # Provider auth stays real; everything else is scratch.
  local real_auth="$HOME/.local/share/opencode/auth.json"
  if [ -f "$real_auth" ]; then
    ln -s "$real_auth" "$DATA_ROOT/auth.json"
  fi

  scratch_write_config "null"

  cd "$SCRATCH/project"
}

# scratch_write_config OPTIONS_JSON — OPTIONS_JSON "null" for the plain form,
# or a JSON object for the tuple form (plugin options).
scratch_write_config() {
  local plugin_entry
  if [ "$1" = "null" ]; then
    plugin_entry="\"$PLUGIN_PATH\""
  else
    plugin_entry="[\"$PLUGIN_PATH\", $1]"
  fi
  cat > "$OPENCODE_CONFIG_DIR/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "$E2E_MODEL",
  "plugin": [$plugin_entry]
}
EOF
  cat > "$OPENCODE_CONFIG_DIR/tui.json" <<EOF
{ "\$schema": "https://opencode.ai/config.json", "plugin": ["$PLUGIN_PATH"] }
EOF
}

scratch_destroy() {
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH" || true
}

build_plugin() {
  (cd "$REPO_ROOT" && bun run build >/dev/null)
}

# The TUI half only renders when the HOST injects its own Solid/OpenTUI
# instances, which only happens when the plugin directory cannot resolve
# those packages locally. A dev checkout's node_modules shadows the injection
# (Solid's node export condition is the SSR build, dist/server.js: signals
# never update, surfaces silently render nothing). Stash the shadowing
# packages for the TUI's lifetime; restore afterwards. Published installs
# don't ship these packages and don't need this.
ULTRAOPEN_STASH="${TMPDIR:-/tmp}/ultraopen-e2e-nm-stash"

stash_host_modules() {
  mkdir -p "$ULTRAOPEN_STASH"
  local m
  for m in solid-js @opentui; do
    if [ -d "$PLUGIN_PATH/node_modules/$m" ] && [ ! -d "$ULTRAOPEN_STASH/$m" ]; then
      mv "$PLUGIN_PATH/node_modules/$m" "$ULTRAOPEN_STASH/$m"
    fi
  done
}

restore_host_modules() {
  local m
  for m in solid-js @opentui; do
    if [ -d "$ULTRAOPEN_STASH/$m" ]; then
      mv "$ULTRAOPEN_STASH/$m" "$PLUGIN_PATH/node_modules/$m"
    fi
  done
}

# Run-dir helpers ---------------------------------------------------------------
runs() { ls -1 "$RUN_ROOT" 2>/dev/null || true; }
runs_snapshot() { runs | sort > "$1"; }                       # usage: runs_snapshot file
runs_new_since() { comm -13 "$1" <(runs | sort) | grep -v '^$' || true; }

manifest_started_at() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("startedAt", 0))' \
    "$RUN_ROOT/$1/manifest.json" 2>/dev/null || echo 0
}

newest_run() { # newest_run FILE → newest run regardless of status
  local best="" best_t=-1 r t
  for r in $(runs_new_since "$1"); do
    t="$(manifest_started_at "$r")"
    if [ "$t" -gt "$best_t" ]; then best="$r"; best_t="$t"; fi
  done
  echo "$best"
}

newest_completed_run() { # newest_completed_run FILE → newest run whose manifest is completed
  local best="" best_t=-1 r t
  for r in $(runs_new_since "$1"); do
    [ "$(manifest_status "$r")" = "completed" ] || continue
    t="$(manifest_started_at "$r")"
    if [ "$t" -gt "$best_t" ]; then best="$r"; best_t="$t"; fi
  done
  echo "$best"
}

manifest_status() {
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' \
    "$RUN_ROOT/$1/manifest.json" 2>/dev/null || echo missing
}

# Copy a run dir into the suite's artifacts for post-mortem. Suites set
# PRESERVE_DIR (their artifacts dir) before the first call.
preserve_run() {
  [ -n "${PRESERVE_DIR:-}" ] || return 0
  [ -d "$RUN_ROOT/$1" ] || return 0
  mkdir -p "$PRESERVE_DIR"
  cp -R "$RUN_ROOT/$1" "$PRESERVE_DIR/$1" 2>/dev/null || true
}

journal_count() {
  # Non-empty lines, tolerant of a missing trailing newline on the last entry.
  local n; n="$(grep -c . "$RUN_ROOT/$1/journal.jsonl" 2>/dev/null || true)"
  echo "${n:-0}"
}
journal_grep() {
  local n; n="$(grep -c -- "$2" "$RUN_ROOT/$1/journal.jsonl" 2>/dev/null || true)"
  echo "${n:-0}"
}

assert_run_completed() {
  if [ "$(manifest_status "$1")" = "completed" ]; then
    ok "run $1: manifest completed"
  else
    bad "run $1: manifest is '$(manifest_status "$1")', expected completed"
  fi
}
assert_run_failed() {
  if [ "$(manifest_status "$1")" = "failed" ]; then
    ok "run $1: manifest failed (as expected)"
  else
    bad "run $1: manifest is '$(manifest_status "$1")', expected failed"
  fi
}

# opencode run wrapper: fresh process, scratch env, auto-approved permissions.
oc_run() { opencode run --auto "$@"; }

# Artifacts ----------------------------------------------------------------------
artifacts_dir() { # artifacts_dir suite-name → prints a fresh dir
  local dir
  dir="$ARTIFACTS_ROOT/$1-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  echo "$dir"
}

# tmux helpers (visual suite) — a dedicated tmux server per suite ---------------
tmx() { tmux -L "$E2E_TMUX_SOCKET" "$@"; }

tui_start() { # tui_start [extra opencode flags...]
  tmx new-session -d -s tui -x 200 -y 50 "opencode --port $E2E_PORT $*"
}
tui_keys()   { tmx send-keys -t tui "$@"; }
tui_capture() { tmx capture-pane -p -t tui; }   # plain text, live grid
tui_frame()  { tmx capture-pane -e -t tui; }    # with colors, for artifacts

pane_contains() { tui_capture | grep -qF -- "$1"; }
pane_lacks()    { ! pane_contains "$1"; }
pane_matches()  { tui_capture | grep -qE -- "$1"; }   # anchored/regex variant

# Submit a prompt with exact text via the TUI's own HTTP API — tmux send-keys
# mangles large pastes often enough to make typed prompts flaky.
tui_http_prompt() { # tui_http_prompt TEXT
  local payload
  payload="$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')"
  curl -sf -X POST "http://127.0.0.1:$E2E_PORT/tui/append-prompt" -H 'Content-Type: application/json' -d "$payload" >/dev/null
  sleep 0.5
  curl -sf -X POST "http://127.0.0.1:$E2E_PORT/tui/submit-prompt" >/dev/null
}

# Compose a prompt that makes the model call the workflow tool with a fixture
# script verbatim. Extra instructions (e.g. resumeFromRunId) go in $2.
wf_prompt() { # wf_prompt FIXTURE [EXTRA]
  printf 'Call the workflow tool now. Pass no scriptPath and no args. %s Use this script exactly, unchanged:\n\n%s\n\nThen reply with the workflow result.' \
    "${2:-}" "$(cat "$E2E_DIR/fixtures/$1.js")"
}

assert_pane_contains() { # desc text [timeout]
  local desc="$1" text="$2" timeout="${3:-30}"
  if wait_for "$timeout" pane_contains "$text"; then
    ok "$desc"
  else
    bad "$desc" "pane never showed: '$text'"
  fi
}
assert_pane_lacks() { # desc text [timeout] — asserts the text disappears
  local desc="$1" text="$2" timeout="${3:-15}"
  if wait_for "$timeout" pane_lacks "$text"; then
    ok "$desc"
  else
    bad "$desc" "pane still shows: '$text'"
  fi
}

health_ok() { curl -sf "http://127.0.0.1:$E2E_PORT/global/health" >/dev/null 2>&1; }
session_exists() { curl -sf "http://127.0.0.1:$E2E_PORT/session" | grep -q "ses_"; }

wait_tui_ready() { # also gates frame dumps until the UI is stable
  if wait_for "$E2E_WAIT_TIMEOUT" health_ok; then
    ok "TUI server ready on port $E2E_PORT"
  else
    bad "TUI server never became ready" "poll /global/health on port $E2E_PORT"
    return 1
  fi
}

tui_quit() {
  # Exit binding is gated on an empty prompt input (app.tsx:982-988): one
  # ctrl+c clears any typed text, the second exits. Send twice.
  tui_keys C-c 2>/dev/null || true
  sleep 1
  tui_keys C-c 2>/dev/null || true
  wait_for 10 tmx_has_session_tui_gone || tmx kill-server 2>/dev/null || true
}
tmx_has_session_tui_gone() { ! tmx has-session -t tui 2>/dev/null; }

# Current session id from the TUI's own server (response shape varies across
# opencode releases; parse tolerantly and print the newest session id).
current_session() {
  curl -sf "http://127.0.0.1:$E2E_PORT/session" | python3 -c '
import json, sys
data = json.load(sys.stdin)
sessions = data if isinstance(data, list) else data.get("sessions") or list(data.values())
best = None
for s in sessions:
    if isinstance(s, dict) and "id" in s:
        best = s["id"]  # keep the last one; /session order is newest-first upstream
print(best if best else "")' 2>/dev/null || echo ""
}

# Synthetic run injection: the TUI reads disk, so a fabricated run dir with the
# live session id renders all three progress surfaces without a model call.
synth_run() { # synth_run RUNID SESSIONID WORKFLOW PHASE LABEL STATUS [LABEL STATUS ...]
  local run_id="$1" session_id="$2" workflow="$3" phase="$4"
  shift 4
  local dir="$RUN_ROOT/$run_id"
  local now; now="$(date +%s000)"
  mkdir -p "$dir"

  python3 - "$dir" "$run_id" "$session_id" "$workflow" "$phase" "$now" "$@" <<'PYEOF'
import json, sys
dir_, run_id, session_id, workflow, phase, now = sys.argv[1:7]
rest = sys.argv[7:]
agents = []
for i in range(0, len(rest), 2):
    agents.append({"index": i // 2, "label": rest[i], "phase": phase, "status": rest[i + 1]})
manifest = {"runId": run_id, "bootId": "synthetic", "pid": 0, "sessionID": session_id,
            "sourceHash": "synthetic", "argsHash": "synthetic", "status": "running",
            "childSessionIDs": [], "startedAt": int(now)}
progress = {"runId": run_id, "workflow": workflow, "sessionID": session_id,
            "phase": phase, "agents": agents, "logs": [], "startedAt": int(now),
            "updatedAt": int(now)}
open(dir_ + "/manifest.json", "w").write(json.dumps(manifest))
open(dir_ + "/progress.json", "w").write(json.dumps(progress))
PYEOF
}

synth_finish() { # flip a synthetic run to a terminal status so surfaces drop it
  python3 - "$RUN_ROOT/$1" "$2" <<'PYEOF'
import json, sys
path, status = sys.argv[1], sys.argv[2]
manifest = json.load(open(path + "/manifest.json"))
manifest["status"] = status
manifest["endedAt"] = manifest["startedAt"] + 60
json.dump(manifest, open(path + "/manifest.json", "w"))
PYEOF
}