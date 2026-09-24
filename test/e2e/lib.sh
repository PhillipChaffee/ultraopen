#!/usr/bin/env bash
# lib.sh — shared environment for the ultraopen e2e suites.
#
# Isolation: every suite runs inside a scratch XDG home, so sessions, run dirs,
# and logs never touch the developer's real opencode state. Provider auth is
# symlinked in (auth.json lives under $XDG_DATA_HOME/opencode/) so real model
# calls work; everything else is throwaway. Config leakage (e2e) is closed
# channel by channel: the XDG redirect below, then the env-override unset and
# non-product weight strip inside scratch_new (#48, #56).
#
# The TUI half resolves the run-data root exactly like the server half
# ($XDG_DATA_HOME else ~/.local/share, then opencode/tool-output/ultraopen),
# so pointing XDG_DATA_HOME at the scratch dir makes the TUI poll the very
# runs this harness creates (src/server/resume/store.ts:27-31, src/tui/data.ts:39-43).
#
# The TUI at opencode 1.18.x only exposes its HTTP server when started with
# --port (otherwise it is an in-process worker), so the visual suite always
# passes --port and readiness-gates on /global/health before any input, then
# gates the first input itself with probe_verify_retry: the TUI's startup
# input-drop window (~10s — opencode issue #42915) has no ready signal, so the
# input's own effect is the only honest verdict.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # absolute: CWD changes after scratch_new
PLUGIN_PATH="$REPO_ROOT"
ARTIFACTS_ROOT="$REPO_ROOT/test/e2e/artifacts"

# Config knobs ----------------------------------------------------------------
E2E_MODEL="${E2E_MODEL:-togetherai/zai-org/GLM-5.3-Flash}"
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

# probe_verify_retry SEND VERIFY [WAIT] [ATTEMPTS] — the readiness gate for
# inputs sent to a freshly booted TUI (opencode #42915: startup capability
# probes consume stdin and silently discard input for ~10s; no ready signal
# exists, so the only honest gate is the input's own effect). Run SEND — the
# case's first real input, no synthetic probe — wait WAIT seconds for VERIFY
# to turn true, retry with backoff: a dropped input costs seconds, never a
# fixed settle (spec §5.1, decision #46).
probe_verify_retry() { # SEND VERIFY [WAIT] [ATTEMPTS]
  local send="$1" verify="$2" wait="${3:-8}" attempts="${4:-3}" attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    "$send"
    if wait_for "$wait" "$verify"; then return 0; fi
    note "attempt $attempt: $verify not verified within ${wait}s — retrying"
    sleep "$((attempt * 2))"
    attempt=$((attempt + 1))
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
  # opencode merges $XDG_CONFIG_HOME/opencode config files into every load on
  # top of OPENCODE_CONFIG_DIR, so leaving this unset lets the developer's real
  # global config (permissions, agents, global MCP servers) leak into each run.
  export XDG_CONFIG_HOME="$SCRATCH/config"
  export OPENCODE_CONFIG_DIR="$SCRATCH/config"
  # third isolation channel — config leakage (e2e): override env inherited from
  # the invoking process
  unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_PERMISSION OPENCODE_TUI_CONFIG
  # non-product per-process weight (1.18.31 flags, flag.ts:23,29 + runtime-flags.ts:19,21)
  export OPENCODE_DISABLE_DEFAULT_PLUGINS=1
  export OPENCODE_DISABLE_EXTERNAL_SKILLS=1
  export OPENCODE_DISABLE_AUTOUPDATE=1
  DATA_ROOT="$XDG_DATA_HOME/opencode"
  RUN_ROOT="$DATA_ROOT/tool-output/ultraopen"
  mkdir -p "$DATA_ROOT" "$OPENCODE_CONFIG_DIR" "$SCRATCH/project"

  # Provider auth stays real; everything else is scratch.
  local real_auth="$HOME/.local/share/opencode/auth.json"
  if [ -f "$real_auth" ]; then
    ln -s "$real_auth" "$DATA_ROOT/auth.json"
  fi

  # autoResume off for the suite's baseline: cases that kill a server mid-run
  # (watchdogs, TUI kills) leave `running` manifests, and a later case's boot
  # must not silently re-execute them. The dedicated auto-resume case flips it
  # on for its own relaunch (technical.sh T12).
  scratch_write_config '{"autoResume": false}'

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
  # A previous abnormal exit may have left a stale stash; fold it back first —
  # the existence guard below would otherwise silently skip stashing.
  restore_host_modules
  mkdir -p "$ULTRAOPEN_STASH"
  local m
  for m in solid-js @opentui; do
    if [ -d "$PLUGIN_PATH/node_modules/$m" ]; then
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

# Cleanup guarantee (#44, evidence #40) ------------------------------------------
# Every test-spawned opencode process must die when a suite ends — including
# abnormal exit — and orphans from prior runs are reclaimed at suite start.
# Three mechanisms: a PID manifest as the primary kill list (argv-guarded),
# an env-marker backstop sweep (ps -wwE; matched env is NEVER printed —
# secrets ride along in every process env), and a detached cleanup reaper
# forked at suite start that runs the teardown when the suite script dies in
# any way its own traps cannot handle (SIGKILL runs no traps; macOS bash 3.2
# discards a pending SIGINT). The engine is in-process — every turn is one
# PID — so there is no process-group machinery, and the port probe is an
# assertion, never a kill input.

OUT=""          # suite artifacts dir; suites set it before the first spawn
REAPER_PID=""
REAPER_LOG=""
E2E_CLEANED=0   # teardown-once guard, shared by the traps and the reaper

manifest_pid() { # manifest_pid PID ARGV — record a spawn site's PID for the sweep.
  # Lives in the artifacts dir, never the scratch: normal exits delete the
  # scratch, abnormal exits never reach scratch_destroy.
  [ -n "$OUT" ] || return 0
  printf '%s\t%s\n' "$1" "$2" >> "$OUT/pids.txt" 2>/dev/null || true
}

manifest_has() { # PID → 0 if recorded in this run's PID manifest
  [ -n "$OUT" ] && [ -f "$OUT/pids.txt" ] || return 1
  awk -F'\t' -v p="$1" '$1 == p { found=1 } END { exit found ? 0 : 1 }' "$OUT/pids.txt"
}

pid_argv_still_matches() { # PID RECORDED_ARGV — PID-reuse guard: kill a recorded PID
  # only when its live argv still carries the recorded spawn's command line
  # (first line; prompts span lines and ps renders newlines as \012).
  local key live
  key="${2%%$'\n'*}"
  [ -n "$key" ] || return 1
  live="$(ps -ww -o command= -p "$1" 2>/dev/null || true)"
  [ -n "$live" ] || return 1
  case "$live" in *"$key"*) return 0 ;; esac
  return 1
}

e2e_kill_pid() { # PID — the kill ladder: SIGTERM → 10s grace → SIGKILL (#44)
  kill -0 "$1" 2>/dev/null || return 0
  kill -TERM "$1" 2>/dev/null || return 0
  local i=0
  while [ "$i" -lt 10 ] && kill -0 "$1" 2>/dev/null; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$1" 2>/dev/null; then
    kill -KILL "$1" 2>/dev/null || true
  fi
  return 0
}

e2e_kill_manifest() { # argv-guarded kill of every recorded PID
  [ -f "$OUT/pids.txt" ] || return 0
  local pid argv
  while IFS="$(printf '\t')" read -r pid argv; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    kill -0 "$pid" 2>/dev/null || continue
    if pid_argv_still_matches "$pid" "$argv"; then
      sweep_note "manifest kill: pid $pid"
      e2e_kill_pid "$pid"
    else
      sweep_note "manifest pid $pid was recycled (argv mismatch) — left to the marker sweep"
    fi
  done < "$OUT/pids.txt"
  return 0
}

# e2e_marker_check PID — exit 0 when the process's environment carries an e2e
# marker (XDG_DATA_HOME / OPENCODE_CONFIG_DIR under ultraopen-e2e.*). The
# ps -E text itself is never printed.
e2e_marker_check() {
  local out
  out="$(ps -wwE -o command= -p "$1" 2>/dev/null || true)"
  case "$out" in
    *XDG_DATA_HOME=*ultraopen-e2e.*|*OPENCODE_CONFIG_DIR=*ultraopen-e2e.*) return 0 ;;
    *) return 1 ;;
  esac
}

e2e_scratch_of() { # TEXT → the ultraopen-e2e XDG_DATA_HOME value found in it, or ""
  printf '%s' "$1" | python3 -c 'import re,sys; m=re.search(r"XDG_DATA_HOME=(\S*ultraopen-e2e\S*)", sys.stdin.read()); print(m.group(1) if m else "")' 2>/dev/null || true
}

sweep_note() { # in-suite diagnostics print; the reaper's land in its own log
  if [ -n "$REAPER_LOG" ]; then
    printf '%s\n' "$1" >> "$REAPER_LOG" 2>/dev/null || true
  else
    note "$1"
  fi
}

# e2e_sweep MODE — the env-marker backstop. startup: kill marker-matched
# processes whose scratch no longer exists (definitively from a finished run)
# and report — never kill — those whose scratch is still live (a concurrent
# run's). exit: kill marker-matched processes carrying THIS run's scratch.
# opencode processes with no marker are noted, never killed; attribution to
# kill stays exclusively marker-based.
e2e_sweep() { # MODE startup|exit
  local mode="$1" own="" line pid rest scratch
  case "$mode" in
    startup) [ "${E2E_SKIP_SWEEP:-0}" = "1" ] && return 0 ;;
    exit)    own="${XDG_DATA_HOME:-}"; [ -n "$own" ] || return 0 ;;
    *)       return 0 ;;
  esac
  while IFS= read -r line; do
    pid=""
    rest=""
    read -r pid rest <<<"$line" || true
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" = "$$" ] && continue
    [ -n "$REAPER_PID" ] && [ "$pid" = "$REAPER_PID" ] && continue
    case "$rest" in
      *XDG_DATA_HOME=*ultraopen-e2e.*|*OPENCODE_CONFIG_DIR=*ultraopen-e2e.*) ;;
      *) continue ;;
    esac
    scratch="$(e2e_scratch_of "$rest")"
    if [ "$mode" = exit ]; then
      if [ "$scratch" = "$own" ]; then
        sweep_note "marker sweep: killing pid $pid (carries this run's scratch)"
        e2e_kill_pid "$pid"
      fi
    else
      if [ -n "$scratch" ] && [ -d "$scratch" ]; then
        sweep_note "startup sweep: pid $pid belongs to a live run (its scratch exists) — not touched"
      else
        sweep_note "startup sweep: reclaiming orphan pid $pid (its scratch is gone)"
        e2e_kill_pid "$pid"
      fi
    fi
  done < <(ps -axwwE -o pid=,command= 2>/dev/null || true)
  if [ "$mode" = startup ]; then
    e2e_note_unmarked
  fi
  return 0
}

e2e_note_unmarked() { # one note line per unmarked opencode process (pid + argv)
  local p cmd
  for p in $(pgrep -x opencode 2>/dev/null || true); do
    e2e_marker_check "$p" && continue
    cmd="$(ps -ww -o command= -p "$p" 2>/dev/null || true)"
    [ -n "$cmd" ] || continue
    note "unattributable opencode process (no e2e marker) — pid $p: $cmd"
  done
  return 0
}

e2e_startup_sweep() { # default on; E2E_SKIP_SWEEP=1 opts out for debugging
  if [ "${E2E_SKIP_SWEEP:-0}" = "1" ]; then
    note "startup sweep skipped (E2E_SKIP_SWEEP=1)"
    return 0
  fi
  e2e_sweep startup
}

# e2e_teardown KIND — the one teardown both the in-script traps and the reaper
# run; idempotent. Kills the manifest, sweeps this run's marker-matched
# stragglers, then the kind-specific file teardown — unless the --keep flag
# file exists. Writes the reaper sentinel last, so a reaper waking on a suite
# that completed its own teardown exits without acting.
e2e_teardown() { # KIND technical|visual
  [ "${E2E_CLEANED:-0}" -eq 1 ] && return 0
  E2E_CLEANED=1
  [ -n "$OUT" ] || return 0
  if [ "$1" = "visual" ]; then
    tmx kill-server 2>/dev/null || true
  fi
  e2e_kill_manifest
  e2e_sweep exit
  if [ "$1" = "visual" ]; then
    restore_host_modules
  fi
  if [ -f "$OUT/keep.flag" ]; then
    sweep_note "scratch kept: $SCRATCH"
  else
    scratch_destroy
  fi
  : > "$OUT/reaper.done" 2>/dev/null || true
  return 0
}

# e2e_start_reaper KIND — fork the detached cleanup reaper: a watcher outside
# the suite script's process. It survives every way the suite can die (it is
# a separate process; INT/HUP/QUIT are ignored so a terminal Ctrl-C or a
# closing terminal cannot stop the cleanup) and, when the suite's PID
# vanishes without the sentinel, runs the full teardown — the abnormal-exit
# backstop. Its output lands in $OUT/reaper.log.
e2e_start_reaper() { # KIND
  REAPER_LOG="$OUT/reaper.log"
  reaper_suite_pid="$$"
  reaper_kind="$1"
  (
    set +e +u +o pipefail
    trap '' HUP INT QUIT
    while kill -0 "$reaper_suite_pid" 2>/dev/null; do sleep 1; done
    if [ ! -f "$OUT/reaper.done" ]; then
      e2e_teardown "$reaper_kind"
    fi
    exit 0
  ) > "$REAPER_LOG" 2>&1 &
  REAPER_PID=$!
}

# assert_port_free — post-suite port-freeness, scoped to e2e: the suite fails
# only if a manifest-PID or marker-matched process still holds the port after
# the settle window; a foreign holder is a note (it would have failed
# wait_tui_ready at boot anyway).
assert_port_free() {
  local holders p e2e=0 foreign="" waited=0
  while [ "$waited" -lt 10 ]; do
    holders="$(lsof -nP -tiTCP:"$E2E_PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$holders" ] && break
    sleep 1
    waited=$((waited + 1))
  done
  holders="$(lsof -nP -tiTCP:"$E2E_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$holders" ]; then
    ok "port $E2E_PORT free after teardown"
    return 0
  fi
  for p in $holders; do
    if manifest_has "$p" || e2e_marker_check "$p"; then
      e2e=1
    else
      foreign="$foreign $p"
    fi
  done
  if [ "$e2e" -eq 1 ]; then
    bad "port $E2E_PORT still held by an e2e process after teardown" "a manifest/marker-matched holder survived the settle window"
  else
    note "port $E2E_PORT held by foreign process(es):$foreign — not e2e's"
  fi
  return 0
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
  local pane_pid
  pane_pid="$(tmx display-message -p -t tui '#{pane_pid}' 2>/dev/null || true)"
  if [ -n "$pane_pid" ]; then
    manifest_pid "$pane_pid" "opencode --port $E2E_PORT $*"
  fi
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
  # The async contract: the tool returns the run id at once, so the model must
  # poll workflow_status with wait until the run settles BEFORE ending the turn
  # — a one-shot `opencode run` exits (process.exit) after the turn, taking an
  # unsettled run with it.
  printf 'Call the workflow tool now. Pass no scriptPath and no args. %s Use this script exactly, unchanged:\n\n%s\n\nThe tool returns a launch result with a run id, not the outcome. Then call workflow_status with that run id and wait=120 (repeat the call if it says running). When the status is completed or failed, reply with what workflow_status reported — the value or the failure. Never end your turn while the run is unsettled.' \
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

# Session rows from the TUI's own server, ids extracted tolerantly (the
# response shape varies across opencode releases). The snapshot/new-since pair
# mirrors runs_snapshot/runs_new_since; a NEW session row is the honest verify
# that a prompt landed, because sessions persist in the scratch across reboots
# and a plain any-session check is pre-satisfied on V4/V5 boots.
sessions_list() { curl -sf "http://127.0.0.1:$E2E_PORT/session" 2>/dev/null | grep -oE 'ses_[A-Za-z0-9]+' | sort -u || true; }
sessions_snapshot() { sessions_list > "$1"; }                  # usage: sessions_snapshot file
sessions_new_since() { comm -13 "$1" <(sessions_list) | grep -v '^$' || true; }
session_landed_since() { [ -n "$(sessions_new_since "$1")" ]; }

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

# Fabricate an interrupted (orphaned) run with the reaper's marker, as if a
# crash happened and a later boot reaped it. Drives the once-per-boot hint.
synth_orphan() { # synth_orphan RUNID SESSIONID WORKFLOW
  local run_id="$1" session_id="$2" workflow="$3"
  local dir="$RUN_ROOT/$run_id"
  local now; now="$(date +%s000)"
  mkdir -p "$dir"
  python3 - "$dir" "$run_id" "$session_id" "$workflow" "$now" <<'PYEOF'
import json, sys
dir_, run_id, session_id, workflow, now = sys.argv[1:6]
manifest = {"runId": run_id, "bootId": "dead-boot", "pid": 0, "sessionID": session_id,
            "sourceHash": "synthetic", "argsHash": "synthetic", "status": "orphaned",
            "childSessionIDs": [], "startedAt": int(now)}
progress = {"runId": run_id, "workflow": workflow, "sessionID": session_id,
            "agents": [], "logs": [], "startedAt": int(now), "updatedAt": int(now)}
open(dir_ + "/manifest.json", "w").write(json.dumps(manifest))
open(dir_ + "/progress.json", "w").write(json.dumps(progress))
open(dir_ + "/interrupted.txt", "w").write(run_id)
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