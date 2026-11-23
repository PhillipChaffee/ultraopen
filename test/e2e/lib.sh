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
# runs this harness creates (src/server/resume/store.ts, src/tui/data.ts).
#
# OpenCode V2.3.2 splits the two halves: `opencode serve --port --hostname`
# owns the HTTP API and the plugin's server runtime, and the TUI attaches with
# `opencode --server <url> --session <id> --auto` — there is no `--port` on the
# TUI and no in-process worker. Every `/api/*` route is Basic-auth protected,
# even with OPENCODE_PASSWORD unset (the server invents a random password), so
# the harness exports a deterministic one and authenticates every probe. The
# input-drop window still exists (~10s — opencode issue #42915) and still has
# no ready signal, so the first input gates itself with probe_verify_retry:
# the input's own effect is the only honest verdict.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # absolute: CWD changes after scratch_new
# PLUGIN_PATH — the tree opencode loads as the plugin. Defaults to this
# checkout; E2E_PLUGIN_PATH overrides it to any installed tree so a re-proof
# runs the real suites against that tree with zero copies (#113), e.g. the
# registry install:
#   E2E_PLUGIN_PATH=~/.cache/opencode/npm/ultraopen@latest/<install>/node_modules/ultraopen \
#     bash test/e2e/technical.sh
PLUGIN_PATH="${E2E_PLUGIN_PATH:-$REPO_ROOT}"
ARTIFACTS_ROOT="$REPO_ROOT/test/e2e/artifacts"

# Config knobs ----------------------------------------------------------------
E2E_MODEL="${E2E_MODEL:-togetherai/zai-org/GLM-5.3-Flash}"
# Isolation is DERIVED from the branch this suite runs from, so two units can
# never share a socket or a port by construction — there is nothing to record
# and nothing to disagree about (the hand-assigned per-unit triples lived in
# ephemeral handoffs and drifted). E2E_* overrides still win for manual control.
# A rare hash collision (two branch ids mapping to one port) fails fast and loud
# at the suites' own startup port checks instead of colliding mid-suite; a stale
# listener on a derived port is almost certainly this branch's own leftover,
# which makes the startup sweep's reclaim safe.
E2E_UNIT_ID="${E2E_UNIT_ID:-$(git -C "$REPO_ROOT" branch --show-current)}"
E2E_UNIT_ID="${E2E_UNIT_ID:-unknown}"
E2E_UNIT_ID="${E2E_UNIT_ID//[^a-zA-Z0-9_-]/-}"   # tmux sockets reject '/'
E2E_TMUX_SOCKET="${E2E_TMUX_SOCKET:-ultraopen-e2e-${E2E_UNIT_ID}}"
E2E_PORT="${E2E_PORT:-$((18880 + $(printf '%s' "$E2E_UNIT_ID" | cksum | cut -d' ' -f1) % 19))}"
E2E_RESUME_PORT="${E2E_RESUME_PORT:-$((E2E_PORT + 1))}"
# V2.3.2 enforces HTTP Basic Auth on every /api route, with a random password
# when OPENCODE_PASSWORD is unset. A deterministic per-run secret keeps the
# harness probes authenticating against the server it started and nothing else.
E2E_PASSWORD="${E2E_PASSWORD:-e2e-${E2E_UNIT_ID}-pw}"
export OPENCODE_PASSWORD="$E2E_PASSWORD"
E2E_WAIT_TIMEOUT="${E2E_WAIT_TIMEOUT:-120}"   # seconds, default for wait_for
E2E_POLL_INTERVAL="${E2E_POLL_INTERVAL:-1}"   # seconds between polls
# seconds, hard max-time on every harness curl probe (#89): a wedged server
# (accepts, never responds) must degrade to a failed probe — which the bounded
# waits turn into a failed case with a frame — never an unbounded hang. Note
# the tradeoff: single-shot probes (tui_http_prompt, current_session) convert
# a slow-but-healthy >5s response into a failure too; raise this if localhost
# p95 approaches the default.
E2E_CURL_TIMEOUT="${E2E_CURL_TIMEOUT:-5}"

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
WORK_DIR=""    # $SCRATCH/project — the server's location (plugin scope)
CONFIG_ROOT="" # $XDG_CONFIG_HOME/opencode — opencode.json + cli.json

scratch_new() {
  SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ultraopen-e2e.XXXXXX")"
  export XDG_DATA_HOME="$SCRATCH/share"
  # V2 keeps its package cache and service registration in their own XDG roots;
  # leaving either at the developer's real path leaks installed plugins and a
  # registered background server into every run.
  export XDG_CONFIG_HOME="$SCRATCH/config"
  export XDG_CACHE_HOME="$SCRATCH/cache"
  export XDG_STATE_HOME="$SCRATCH/state"
  mkdir -p "$SCRATCH/tmp" "$XDG_CACHE_HOME" "$XDG_STATE_HOME"
  export TMPDIR="$SCRATCH/tmp"  # Config leakage (e2e): override env inherited from the invoking process.
  # OPENCODE_CONFIG_DIR used to force V1's config directory; V2 reads
  # $XDG_CONFIG_HOME/opencode, so the variable is dropped rather than set.
  unset OPENCODE_CONFIG_DIR OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT \
    OPENCODE_CLI_CONFIG_CONTENT OPENCODE_SERVER OPENCODE_DB OPENCODE_API_KEY \
    OPENCODE_PERMISSION OPENCODE_TUI_CONFIG
  DATA_ROOT="$XDG_DATA_HOME/opencode"
  RUN_ROOT="$DATA_ROOT/tool-output/ultraopen"
  CONFIG_ROOT="$XDG_CONFIG_HOME/opencode"
  WORK_DIR="$SCRATCH/project"
  mkdir -p "$DATA_ROOT" "$CONFIG_ROOT" "$WORK_DIR"

  # Provider auth stays real; everything else is scratch. V2 auto-migrates the
  # auth.json symlink into its SQLite credential table on first boot.
  local real_auth="$HOME/.local/share/opencode/auth.json"
  if [ -f "$real_auth" ]; then
    ln -s "$real_auth" "$DATA_ROOT/auth.json"
  fi

  # autoResume off for the suite's baseline: cases that kill a server mid-run
  # (watchdogs, TUI kills) leave `running` manifests, and a later case's boot
  # must not silently re-execute them. The dedicated auto-resume case flips it
  # on for its own relaunch (technical.sh T12).
  scratch_write_config '{"autoResume": false}'

  cd "$WORK_DIR"
}

# scratch_write_config OPTIONS_JSON — OPTIONS_JSON "null" for the plain form,
# or a JSON object for the plugin's option bag. V2 reads `plugins` (an ordered
# list of strings or {package, options} entries) and always reads cli.json from
# $XDG_CONFIG_HOME/opencode; there is no V1 tui.json.
scratch_write_config() {
  local plugin_entry
  if [ "$1" = "null" ]; then
    plugin_entry="\"$PLUGIN_PATH\""
  else
    plugin_entry="{\"package\": \"$PLUGIN_PATH\", \"options\": $1}"
  fi
  cat > "$CONFIG_ROOT/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "$E2E_MODEL",
  "update": "disable",
  "plugins": [$plugin_entry]
}
EOF
  # The sidebar starts open at 200x50 in V2; hide it so the visual suite's
  # explicit Ctrl-x b toggle has a deterministic starting state.
  cat > "$CONFIG_ROOT/cli.json" <<EOF
{ "\$schema": "https://opencode.ai/config.json", "session": { "sidebar": "hide" } }
EOF
}

scratch_destroy() {
  [ -n "$SCRATCH" ] && rm -rf "$SCRATCH" || true
}

build_plugin() {
  (cd "$REPO_ROOT" && bun run build >/dev/null)
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
# marker (XDG_DATA_HOME / XDG_CONFIG_HOME under ultraopen-e2e.*). The
# ps -E text itself is never printed.
e2e_marker_check() {
  local out
  out="$(ps -wwE -o command= -p "$1" 2>/dev/null || true)"
  case "$out" in
    *XDG_DATA_HOME=*ultraopen-e2e.*|*XDG_CONFIG_HOME=*ultraopen-e2e.*) return 0 ;;
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
      *XDG_DATA_HOME=*ultraopen-e2e.*|*XDG_CONFIG_HOME=*ultraopen-e2e.*) ;;
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
  server_stop
  e2e_kill_manifest
  e2e_sweep exit
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

# opencode run wrapper: fresh standalone process, scratch env, auto-approved
# permissions. V2's --standalone spawns a private stdio server so the turn
# cannot leak into a developer's background service.
oc_run() { opencode run --standalone --auto "$@"; }

# Artifacts ----------------------------------------------------------------------
artifacts_dir() { # artifacts_dir suite-name → prints a fresh dir
  local dir
  dir="$ARTIFACTS_ROOT/$1-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  echo "$dir"
}

# HTTP helpers (server half) -----------------------------------------------------
API_BASE="http://127.0.0.1:$E2E_PORT"
SERVER_PID=""

# Every /api request carries the deterministic password: V2 returns 401 without
# it (and a V1 route would return 200 text/html, so a route typo must not be
# able to look like success).
api_curl() { curl -sf -m "$E2E_CURL_TIMEOUT" -u "opencode:$E2E_PASSWORD" "$@"; }

health_ok() { api_curl "$API_BASE/api/info" 2>/dev/null | grep -q '"version"'; }

# Location plugins boot lazily on opencode serve: /api/info and /api/session do
# NOT boot them, so the visual suite warms the location before it asserts any
# plugin surface, and T12 does the same before it relies on the boot sweep.
warm_location() {
  curl -sf -m "$E2E_CURL_TIMEOUT" -u "opencode:$E2E_PASSWORD" -G \
    --data-urlencode "location[directory]=$WORK_DIR" \
    "$API_BASE/api/agent" >/dev/null 2>&1 || true
}

server_start() {
  health_ok && return 0
  OPENCODE_PASSWORD="$E2E_PASSWORD" opencode serve --port "$E2E_PORT" --hostname 127.0.0.1 \
    >"${OUT:-/dev/null}/serve.log" 2>&1 &
  SERVER_PID=$!
  manifest_pid "$SERVER_PID" "opencode serve --port $E2E_PORT --hostname 127.0.0.1"
}

server_stop() {
  [ -n "$SERVER_PID" ] || return 0
  e2e_kill_pid "$SERVER_PID"
  SERVER_PID=""
}

# Session rows from the server. V2 wraps pages as { data: [...], cursor } and
# `order=desc` puts the newest first. The snapshot/new-since pair mirrors
# runs_snapshot/runs_new_since; a NEW session row is the honest verify that a
# prompt landed, because sessions persist in the scratch across reboots.
sessions_list() {
  api_curl "$API_BASE/api/session?order=desc" 2>/dev/null | python3 -c '
import json, sys
try: data = json.load(sys.stdin)
except Exception: sys.exit(0)
for s in data.get("data", []):
    if isinstance(s, dict) and isinstance(s.get("id"), str):
        print(s["id"])' | sort -u || true
}
sessions_snapshot() { sessions_list > "$1"; }                  # usage: sessions_snapshot file
sessions_new_since() { comm -13 "$1" <(sessions_list) | grep -v '^$' || true; }
session_landed_since() { [ -n "$(sessions_new_since "$1")" ]; }

# Current (newest) session id from the server.
current_session() {
  api_curl "$API_BASE/api/session?order=desc" 2>/dev/null | python3 -c '
import json, sys
try: data = json.load(sys.stdin)
except Exception: sys.exit(0)
rows = data.get("data") or []
if rows and isinstance(rows[0], dict) and isinstance(rows[0].get("id"), str):
    print(rows[0]["id"])' 2>/dev/null || true
}

# Create a session without a model call; V2 returns { data: Session.Info }.
session_create() { # [TITLE] → echoes the new session id
  api_curl -X POST -H 'Content-Type: application/json' \
    -d "{\"title\":\"${1:-e2e session}\"}" \
    "$API_BASE/api/session" | python3 -c '
import json, sys
try: body = json.load(sys.stdin)
except Exception: sys.exit(1)
data = body.get("data") or {}
sid = data.get("id")
if isinstance(sid, str) and sid: print(sid)
else: sys.exit(1)'
}

# tmux helpers (visual suite) — a dedicated tmux server per suite ---------------
tmx() { tmux -L "$E2E_TMUX_SOCKET" "$@"; }

# tui_start [extra opencode flags...] — start the V2 server half, warm its
# location plugin, then attach the TUI inside tmux. The server stays up across
# TUI reboots (V4/V5) so a synthetic case costs zero model calls.
tui_start() { # tui_start [opencode --session ID --auto ...]
  server_start
  if ! wait_for "$E2E_WAIT_TIMEOUT" health_ok; then
    bad "opencode server never became ready" "poll /api/info on port $E2E_PORT"
    return 1
  fi
  warm_location
  tmx new-session -d -s tui -x 200 -y 50 \
    "OPENCODE_PASSWORD='$E2E_PASSWORD' opencode --server '$API_BASE' $*"
  local pane_pid
  pane_pid="$(tmx display-message -p -t tui '#{pane_pid}' 2>/dev/null || true)"
  if [ -n "$pane_pid" ]; then
    manifest_pid "$pane_pid" "opencode --server $API_BASE $*"
  fi
}
tui_keys()   { tmx send-keys -t tui "$@"; }
tui_capture() { tmx capture-pane -p -t tui; }   # plain text, live grid
tui_frame()  { tmx capture-pane -e -t tui; }    # with colors, for artifacts

tui_stop() { tui_quit 2>/dev/null || true; server_stop; }

pane_contains() { tui_capture | grep -qF -- "$1"; }
pane_lacks()    { ! pane_contains "$1"; }
pane_matches()  { tui_capture | grep -qE -- "$1"; }   # anchored/regex variant

# Submit a prompt through the session API — tmux send-keys mangles large pastes
# often enough to make typed prompts flaky. SESSION_ID must name the TUI's
# current session (pre-created with session_create, or resolved after boot).
tui_http_prompt() { # tui_http_prompt TEXT
  local payload
  [ -n "${SESSION_ID:-}" ] || { bad "tui_http_prompt: no SESSION_ID"; return 1; }
  payload="$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')"
  api_curl -X POST "$API_BASE/api/session/$SESSION_ID/prompt" \
    -H 'Content-Type: application/json' -d "$payload" >/dev/null
}

# Compose a prompt that makes the model call the workflow tool with a fixture
# script verbatim. Extra instructions (e.g. resumeFromRunId) go in $2.
wf_prompt() { # wf_prompt FIXTURE [EXTRA]
  # The async contract: the tool returns the run id at once, so the model must
  # poll workflow_status with wait until the run settles BEFORE ending the turn
  # — a one-shot `opencode run` exits (process.exit) after the turn, taking an
  # unsettled run with it. The args/scriptPath omission is pinned hard (not
  # just "no args"): Flash has been observed decorating the call with
  # zero-values ("" or the string "null"), and an args value changes the
  # manifest's argsHash — the resume-replay asserts below depend on the pin
  # holding on both the launch and the resume.
  printf 'Call the workflow tool now. Pass no scriptPath and no args — omit both fields entirely; do not pass empty strings or the string "null". %s Use this script exactly, unchanged:\n\n%s\n\nThe tool returns a launch result with a run id, not the outcome. Then call workflow_status with that run id and wait=120 (repeat the call if it says running). When the status is completed or failed, reply with what workflow_status reported — the value or the failure. Never end your turn while the run is unsettled.' \
    "${2:-}" "$(cat "$E2E_DIR/fixtures/$1.js")"
}

# The resume variant of wf_prompt, with the args pin. A resume replays only
# while the resume call's args still hash to the source run's argsHash; the
# model decorating the call with the string "null" (observed live, T10) or any
# other placeholder changes that hash, and the argsChanged guard then refuses
# the replay BY DESIGN. The pin names the omission; the retry at each resume
# site covers the weather class that ignores it.
resume_prompt() { # resume_prompt FIXTURE RUNID
  wf_prompt "$1" "Set resumeFromRunId to $2. Omit the args field entirely — do not pass \"null\", an empty string, or any placeholder: any args value on a resume changes the args hash and blocks the replay by design."
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
assert_pane_matches() { # desc regex [timeout]
  local desc="$1" regex="$2" timeout="${3:-30}"
  if wait_for "$timeout" pane_matches "$regex"; then
    ok "$desc"
  else
    bad "$desc" "pane never matched: '$regex'"
  fi
}

wait_tui_ready() { # also gates frame dumps until the UI is stable
  if wait_for "$E2E_WAIT_TIMEOUT" health_ok; then
    ok "opencode server ready on port $E2E_PORT"
  else
    bad "opencode server never became ready" "poll /api/info on port $E2E_PORT"
    return 1
  fi
}

tui_quit() {
  # V2 exits on a single ctrl+c with an empty prompt; keep a second only as the
  # fallback when the first is consumed by a dismissable dialog.
  tui_keys C-c 2>/dev/null || true
  if ! wait_for 10 tmx_has_session_tui_gone; then
    tui_keys C-c 2>/dev/null || true
    wait_for 5 tmx_has_session_tui_gone || tmx kill-server 2>/dev/null || true
  fi
}
tmx_has_session_tui_gone() { ! tmx has-session -t tui 2>/dev/null; }

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
    # A child session id per agent (#150), synthetic like everything here: the surfaces'
    # id-bearing rows are exercised the same way their labels are, without a model call.
    agents.append({"index": i // 2, "label": rest[i], "phase": phase, "status": rest[i + 1],
                   "sessionID": f"ses_synth{i // 2}"})
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