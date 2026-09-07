#!/usr/bin/env bash
# technical.sh — end-to-end technical verification of the ultraopen plugin in a
# REAL opencode session: headless `opencode run` mode, a fresh process per case,
# real model calls (pennies on Together), state asserted on the plugin's own
# on-disk run artifacts (manifest/journal/result).
#
# Usage:  bash test/e2e/technical.sh [--keep]
#   --keep   keep the scratch XDG home for post-mortem (path printed at exit)
# Env:     E2E_MODEL, E2E_WAIT_TIMEOUT

cd "$(dirname "$0")" || exit 1
# shellcheck source=lib.sh
source ./lib.sh

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
cleanup() { [ $KEEP -eq 1 ] && note "scratch kept: $SCRATCH"; scratch_destroy; }
[ $KEEP -eq 1 ] || trap cleanup EXIT

OUT="$(artifacts_dir technical)"
export PRESERVE_DIR="$OUT"   # consumed by lib.sh's preserve_run

# opencode run with a watchdog: capture output to a file, never hang the suite.
oc_run_capture() { # FILE SECONDS args...
  local out="$1" secs="$2"; shift 2
  opencode run --auto "$@" >"$out" 2>&1 &
  local pid=$!
  local deadline=$((SECONDS + secs))
  while kill -0 "$pid" 2>/dev/null && [ $SECONDS -lt $deadline ]; do sleep 2; done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "[harness] watchdog: killed a run that exceeded ${secs}s" >>"$out"
  else
    wait "$pid" 2>/dev/null || echo "[harness] opencode run exited non-zero" >>"$out"
  fi
  return 0
}

# Compose a prompt via lib.sh's wf_prompt; fixtures live beside lib.sh.

result_json_has() { # result_json_has RUNID PYTHON_EXPR — assert the python expr over result.json
  python3 - "$RUN_ROOT/$1/result.json" "$2" <<'PYEOF'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0 if eval(sys.argv[2], {"d": data}) else 1)
PYEOF
}

section "setup"
scratch_new
note "scratch: $SCRATCH"
build_plugin && ok "plugin built (dist/ fresh)" || { bad "plugin build failed"; finish; exit 1; }

section "T0 — model sanity (auth + default model reach the provider)"
oc_run_capture "$OUT/t0.out" 240 "Reply with exactly the word READY." || true
grep -q "READY" "$OUT/t0.out" \
  && ok "model answered in scratch env" \
  || { bad "model did not answer in scratch env" "see $OUT/t0.out — auth symlink or provider config broken; aborting"; finish; exit 1; }

section "T1 — workflow tool end-to-end (load, permission auto-approve, schema forcing)"
runs_snapshot "$OUT/runs-before-t1.txt"
oc_run_capture "$OUT/t1.out" 300 "$(wf_prompt smoke)" || true
RUN1_ALL="$(runs_new_since "$OUT/runs-before-t1.txt")"
for r in $RUN1_ALL; do preserve_run "$r"; done
RUN1="$(newest_completed_run "$OUT/runs-before-t1.txt")"
if [ -n "$RUN1" ]; then
  ok "run dir created: $RUN1"
  RUN1_ATTEMPTS="$(printf '%s' "$RUN1_ALL" | grep -c . || true)"
  if [ "$RUN1_ATTEMPTS" -gt 1 ]; then
    note "$RUN1_ATTEMPTS workflow attempts this turn; asserting on the completed one (outer model self-retried a transient failure)"
  fi
  assert_run_completed "$RUN1"
  [ "$(journal_count "$RUN1")" -ge 1 ] && ok "journal has $(journal_count "$RUN1") entry" || bad "journal empty"
  result_json_has "$RUN1" '"answer" in d' && ok "schema-forced result shape {answer}" || bad "result.json missing answer"
  result_json_has "$RUN1" '"READY" in d.get("answer", "").upper()' && ok "agent answer READY" || bad "agent answer not READY"
else
  bad "no completed run dir" "attempts: $(printf '%s' "$RUN1_ALL" | tr '\n' ' ') — see $OUT/t1.out"
fi

section "T3 — resume across processes (self-contained baseline + resume)"
runs_snapshot "$OUT/runs-before-t3a.txt"
oc_run_capture "$OUT/t3a.out" 300 "$(wf_prompt smoke)" || true
BASE="$(newest_completed_run "$OUT/runs-before-t3a.txt")"
preserve_run "$BASE"
if [ -z "$BASE" ]; then
  # One retry: the schema path hits transient provider errors ~1 in 3 turns
  # (reason: api-error in the journal); the outer model usually self-heals,
  # but a turn can still end with no completed run.
  runs_snapshot "$OUT/runs-before-t3a2.txt"
  oc_run_capture "$OUT/t3a2.out" 300 "$(wf_prompt smoke)" || true
  BASE="$(newest_completed_run "$OUT/runs-before-t3a.txt")"
  preserve_run "$BASE"
fi
if [ -n "$BASE" ]; then
  assert_run_completed "$BASE"
  runs_snapshot "$OUT/runs-before-t3b.txt"
  # -c continues the most recent session in the scratch dir — resume is
  # same-session-only (src/server/resume/persist.ts), so the journal loads.
  oc_run_capture "$OUT/t3b.out" 300 -c "$(wf_prompt smoke "Set resumeFromRunId to $BASE.")" || true
  RUN3="$(runs_new_since "$OUT/runs-before-t3b.txt" | head -1)"
  preserve_run "$RUN3"
  if [ -n "$RUN3" ]; then
    ok "resume run dir created: $RUN3"
    assert_run_completed "$RUN3"
    [ "$(journal_grep "$RUN3" '"replayed":true')" -ge 1 ] \
      && ok "journal entry replayed from $BASE (zero live agents)" \
      || bad "no replayed journal entry" "grep replayed in $OUT/$RUN3/journal.jsonl"
    result_json_has "$RUN3" '"READY" in d.get("answer", "").upper()' \
      && ok "resumed result is the recorded baseline value" \
      || bad "resumed result differs from baseline" "replay must return the journaled value, got: $(cat "$OUT/$RUN3/result.json" 2>/dev/null)"
  else
    bad "resume produced no run dir" "see $OUT/t3b.out"
  fi
else
  bad "baseline run for T3 failed" "see $OUT/t3a.out"
fi

section "T2 — parallel fan-out (3 agents, barrier, journal)"
runs_snapshot "$OUT/runs-before-t2.txt"
oc_run_capture "$OUT/t2.out" 600 "$(wf_prompt parallel)" || true
RUN2="$(newest_completed_run "$OUT/runs-before-t2.txt")"
preserve_run "$RUN2"
if [ -n "$RUN2" ]; then
  ok "run dir created: $RUN2"
  assert_run_completed "$RUN2"
  [ "$(journal_count "$RUN2")" -eq 3 ] && ok "journal has exactly 3 entries" || bad "journal has $(journal_count "$RUN2") entries, expected 3"
  result_json_has "$RUN2" 'len(d.get("answers", [])) == 3' && ok "3 answers returned" || bad "answers != 3"
else
  bad "no completed run dir" "see $OUT/t2.out (watchdog kills print there)"
fi

section "T4 — nested workflow({script})"
runs_snapshot "$OUT/runs-before-t4.txt"
oc_run_capture "$OUT/t4.out" 300 "$(wf_prompt nested)" || true
T4_RUNS="$(runs_new_since "$OUT/runs-before-t4.txt")"
for r in $T4_RUNS; do preserve_run "$r"; done
RUN4="$(newest_completed_run "$OUT/runs-before-t4.txt")"
T4_COUNT="$(printf '%s' "$T4_RUNS" | grep -c . || true)"
if [ -n "$RUN4" ]; then
  [ "$T4_COUNT" -eq 1 ] && ok "one run dir (nested runs share the parent's, by design)" \
    || note "$T4_COUNT run dirs (outer model retried); asserting on the completed one"
  assert_run_completed "$RUN4"
  grep -q "INNER" "$OUT/t4.out" && ok "nested result surfaced to the outer return" || bad "nested word INNER not in output"
else
  bad "no completed run dir" "see $OUT/t4.out"
fi

section "T5 — named-workflow form (evidence probe: expected to fail)"
runs_snapshot "$OUT/runs-before-t5.txt"
oc_run_capture "$OUT/t5.out" 300 "$(wf_prompt named)" || true
RUN5="$(newest_run "$OUT/runs-before-t5.txt")"
if [ -n "$RUN5" ]; then
  preserve_run "$RUN5"
  assert_run_failed "$RUN5"
  if grep -qi "no saved workflow" "$OUT/t5.out"; then
    note "evidence: named form throws 'No saved workflow' — context.named never populated (see triage)"
  else
    note "run failed without the named-form message — inspect $OUT/$RUN5 and $OUT/t5.out"
  fi
else
  bad "named-form probe produced no run dir" "see $OUT/t5.out"
fi

section "T6 — isolation: worktree (evidence probe)"
git init -q . 2>/dev/null || true
runs_snapshot "$OUT/runs-before-t6.txt"
oc_run_capture "$OUT/t6.out" 300 "$(wf_prompt worktree)" || true
RUN6="$(newest_completed_run "$OUT/runs-before-t6.txt")"
preserve_run "$RUN6"
if [ -n "$RUN6" ]; then
  assert_run_completed "$RUN6"
  note "evidence: isolation:'worktree' accepted and run completed; check $SCRATCH for worktrees — worktreeRoot is not wired in src/server/index.ts (see triage)"
  [ -z "$(find "$SCRATCH" -type d -name '*worktree*' 2>/dev/null | head -1)" ] \
    && note "no worktree directory created — isolation opt is inert in the live path"
fi

section "T7 — agentDeadlineMs option (tuple-form options reach the engine)"
scratch_write_config '{"agentDeadlineMs": 1}'
runs_snapshot "$OUT/runs-before-t7.txt"
oc_run_capture "$OUT/t7.out" 300 "$(wf_prompt smoke)" || true
RUN7="$(newest_run "$OUT/runs-before-t7.txt")"
if [ -n "$RUN7" ]; then
  preserve_run "$RUN7"
  assert_run_failed "$RUN7"
  [ "$(journal_grep "$RUN7" '\"reason\":\"deadline\"')" -ge 1 ] \
    && ok "deadline expiry recorded in the journal (reason: deadline)" \
    || bad "deadline reason missing from journal" "inspect $OUT/$RUN7/journal.jsonl"
else
  bad "deadline probe produced no run dir" "see $OUT/t7.out"
fi
scratch_write_config "null"

section "T8 — ultracode keyword surface (effort raise on the turn)"
runs_snapshot "$OUT/runs-before-t8.txt"
oc_run_capture "$OUT/t8.json" 300 --format json "ultracode $(wf_prompt smoke)" || true
RUN8="$(newest_completed_run "$OUT/runs-before-t8.txt")"
if [ -z "$RUN8" ]; then
  # Parent turns can stall on provider hiccups (opencode retries with no cap);
  # one retry keeps the suite from flaking on transient hangs.
  note "no run from the first attempt (stall or non-compliance) — retrying once"
  runs_snapshot "$OUT/runs-before-t8b.txt"
  oc_run_capture "$OUT/t8b.json" 300 --format json "ultracode $(wf_prompt smoke)" || true
  RUN8="$(newest_completed_run "$OUT/runs-before-t8.txt")"
fi
preserve_run "$RUN8"
if [ -n "$RUN8" ]; then
  ok "ultracode-keyword turn created run: $RUN8"
  assert_run_completed "$RUN8"
  if grep -q '"variant" *: *"\(xhigh\|high\|max\)"' "$OUT/t8.json" "$OUT/t8b.json" 2>/dev/null; then
    ok "effort variant applied to the turn (see $OUT/t8*.json)"
  else
    note "evidence: no reasoning variant on this model's turn — GLM-5.3's variant map may be empty, effort is a no-op on this provider (check run logs)"
  fi
else
  bad "ultracode turn produced no run dir" "see $OUT/t8.json"
fi

[ -f "$DATA_ROOT/log/opencode.log" ] && cp "$DATA_ROOT/log/opencode.log" "$OUT/server.log" 2>/dev/null || true
finish