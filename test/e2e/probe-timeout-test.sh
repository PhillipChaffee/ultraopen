#!/usr/bin/env bash
# probe-timeout-test.sh — harness regression test for #89: every HTTP probe in
# the e2e harness carries a hard curl timeout, so a WEDGED server (accepts
# connections, never responds) degrades to a failed probe — which the bounded
# waits turn into a failed case with a boot-failed frame — instead of an
# unbounded hang (the 2026-09-26 visual-suite incident: 53 silent minutes).
#
# This is a harness unit test, not one of the live suites: no opencode, no
# model. It sources lib.sh for the real probe/wait functions and simulates the
# wedge with a local accept-and-never-respond holder. The holder must PROVE
# the wedge before any case runs (a curl against it must provably burn its
# full max-time and exit 28) so a dead holder can never green-light the test
# via instant connection-refused. The holder self-expires so even a SIGKILLed
# test run cannot leak it forever.
#
# Usage:  bash test/e2e/probe-timeout-test.sh
# Env:    E2E_PORT (default 18993); E2E_WAIT_TIMEOUT / E2E_CURL_TIMEOUT /
#         E2E_POLL_INTERVAL are forced small here to prove the knob threads
#         through.

set -euo pipefail

E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Static guard: every curl in the harness files carries -m "$E2E_CURL_TIMEOUT"
# — exactly the knob, so a renamed or hand-rolled bound fails here. A bare curl
# is the #89 bug class. Comment lines mentioning curl don't count.
probe_timeout_static() {
  local f raw filtered
  for f in "$E2E_DIR/lib.sh" "$E2E_DIR/technical.sh" "$E2E_DIR/visual.sh"; do
    [ -f "$f" ] || {
      printf '  ✗ static scan: harness file missing: %s\n' "$f"
      return 1
    }
  done
  rg --version >/dev/null 2>&1 || {
    printf '  ✗ rg not available — the static scan cannot run (fail loudly, never pass vacuously)\n'
    return 1
  }
  raw="$(rg -n '\bcurl\b' "$E2E_DIR/lib.sh" "$E2E_DIR/technical.sh" "$E2E_DIR/visual.sh")"
  filtered="$(printf '%s\n' "$raw" | rg -v '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
  if [ -z "$filtered" ]; then
    printf '  ✗ static scan filtered every curl line — the scan itself is broken\n'
    return 1
  fi
  local violations=0
  while IFS= read -r line; do
    case "$line" in *-m\ \""\$E2E_CURL_TIMEOUT"\"*) ;; *)
      printf '  ✗ curl without hard timeout: %s\n' "$line"
      violations=$((violations + 1))
      ;;
    esac
  done <<< "$filtered"
  [ "$violations" -eq 0 ]
}

# Wedged holder on PORT: bind, listen, accept every connection, never respond;
# self-expires so a SIGKILLed test run cannot orphan it forever. stdio
# detached: a command-substituted caller waits for ALL holders of its stdout
# pipe — python must never inherit it.
wedged_holder_start() { # wedged_holder_start PORT → echoes holder pid
  python3 - "$1" <<'PY' >/dev/null 2>&1 &
import signal, socket, sys, time
signal.alarm(120)
srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", int(sys.argv[1])))
srv.listen(16)
conns = []
while True:
    conns.append(srv.accept()[0])
    time.sleep(1)
PY
  echo $!
}

# Reclaim a stale listener (a SIGKILLed prior run's holder) on the dedicated
# test port — the same reclaim-orphan-at-startup pattern as the suites' sweep,
# scoped to a port only this test uses.
port_reclaim() {
  local pid
  for pid in $(lsof -tiTCP:"$E2E_PORT" -sTCP:LISTEN 2>/dev/null || true); do
    printf '  · reclaiming stale listener on port %s: pid %s\n' "$E2E_PORT" "$pid"
    kill "$pid" 2>/dev/null || true
  done
}

# Small forced bounds: the knobs must thread through (a hardcoded 120/5 would
# trip the watchdog below), and the test stays quick.
export E2E_PORT="${E2E_PORT:-18993}"
export E2E_WAIT_TIMEOUT=3
export E2E_CURL_TIMEOUT=2
export E2E_POLL_INTERVAL=1
# shellcheck disable=SC1091
source "$E2E_DIR/lib.sh"

OUT="$(mktemp -d)"
port_reclaim
holder_pid="$(wedged_holder_start "$E2E_PORT")"
cleanup() {
  kill "$holder_pid" 2>/dev/null || true
  rm -rf "$OUT"
}
trap cleanup EXIT

fails=0
bad_() { printf '  ✗ %s\n' "$1"; fails=$((fails + 1)); }
good_() { printf '  ✓ %s\n' "$1"; }

# wedge_proven — the wedge must be proven, not assumed: a curl with the same
# probe shape as health_ok must burn its FULL max-time and exit 28
# (28 = timed out; 7 = refused → holder dead or port raced; 0 = a responding
# foreign listener stole the port). Retry past the bind window, bounded (~10s).
wedge_proven() {
  local waited=0 rc
  while [ "$waited" -lt 20 ]; do
    rc=0
    curl -sf -m "$E2E_CURL_TIMEOUT" "http://127.0.0.1:$E2E_PORT/global/health" >/dev/null 2>&1 || rc=$?
    case "$rc" in
      28) return 0 ;;
      7)  sleep 0.5; waited=$((waited + 1)) ;;
      *)  printf '  ✗ port %s is not wedged (probe rc %s — responding foreign listener?)\n' "$E2E_PORT" "$rc"
          return 1 ;;
    esac
  done
  printf '  ✗ holder never bound port %s after ~10s (holder died?)\n' "$E2E_PORT"
  return 1
}
if wedge_proven; then
  good_ "wedge proven: probe against the holder burned its max-time and timed out (rc 28)"
else
  bad_ "wedged holder not proven on port $E2E_PORT — cases below are void"
fi

# bounded_wait_tui_ready — run wait_tui_ready under a watchdog of WAIT + CURL
# + slack; prints "hung" past the watchdog (the #89 bug class), else rc+elapsed
# as the ONLY stdout line (the probe's own ok/bad chatter goes to stderr).
bounded_wait_tui_ready() {
  local start deadline wpid rc
  start="$(date +%s)"
  deadline=$((E2E_WAIT_TIMEOUT + E2E_CURL_TIMEOUT + 10))
  wait_tui_ready >&2 & wpid=$!
  while kill -0 "$wpid" 2>/dev/null && [ "$(($(date +%s) - start))" -lt "$deadline" ]; do
    sleep 0.5
  done
  if kill -0 "$wpid" 2>/dev/null; then
    kill -9 "$wpid" 2>/dev/null || true
    wait "$wpid" 2>/dev/null || true
    printf 'hung %s\n' "$deadline"
    return 99
  fi
  rc=0; wait "$wpid" 2>/dev/null || rc=$?
  printf 'rc %s elapsed %s\n' "$rc" "$(($(date +%s) - start))"
  return "$rc"
}

# The incident seam: wait_tui_ready must FAIL BOUNDED against the wedge, and
# deterministically (two runs — the caller's `|| { frame …; }` precondition in
# visual.sh:96 holds only if failure is repeatable). Watchdog is WAIT + CURL +
# slack; anything past it is the unbounded hang class. rc 0 against a wedge is
# a false-positive probe (also the bug). The wedge is re-proven between runs
# so a mid-test holder death can never green-light via connection-refused.
bound=$((E2E_WAIT_TIMEOUT + E2E_CURL_TIMEOUT + 2))
run=1
while [ "$run" -le 2 ]; do
  result="$(bounded_wait_tui_ready || true)"
  case "$result" in
    hung*)
      bad_ "run $run: wait_tui_ready still hung (${result}) — unbounded probe (the #89 bug)"
      ;;
    "rc 0"*)
      bad_ "run $run: wait_tui_ready succeeded against a wedged server (rc 0)"
      ;;
    "rc "*)
      elapsed="${result##*elapsed }"
      if [ "$elapsed" -gt "$bound" ]; then
        bad_ "run $run: failed but took ${elapsed}s — bound is E2E_WAIT_TIMEOUT + probe timeout (${bound}s)"
      else
        good_ "run $run: wait_tui_ready failed bounded against the wedge: ${result} (bound ${bound}s)"
      fi
      ;;
    *)
      bad_ "run $run: unexpected bounded run result: ${result:-<empty>}"
      ;;
  esac
  if [ "$run" -lt 2 ]; then
    if wedge_proven; then
      good_ "wedge re-proven before the second run (a dead holder cannot fake this case)"
    else
      bad_ "wedge not re-proven — run 2 is void"
    fi
  fi
  run=$((run + 1))
done

# Static — no bare curl anywhere in the harness.
if probe_timeout_static; then
  good_ "every curl in lib.sh/technical.sh/visual.sh carries -m \"\$E2E_CURL_TIMEOUT\""
else
  bad_ "bare curl(s) in the harness or broken scan (see lines above)"
fi

printf '\n== probe-timeout: %d failed ==\n' "$fails"
[ "$fails" -eq 0 ] || exit 1