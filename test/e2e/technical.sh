#!/usr/bin/env bash
# technical.sh — end-to-end technical verification of the ultraopen plugin in a
# REAL opencode session: headless `opencode run` mode, a fresh process per case,
# real model calls (pennies on Together), state asserted on the plugin's own
# on-disk run artifacts (manifest/journal/result).
#
# Usage:  bash test/e2e/technical.sh [--keep]
#   --keep   keep the scratch XDG home for post-mortem (path printed at exit)
# Env:     E2E_MODEL, E2E_WAIT_TIMEOUT
#
# Echo ceiling (#54): the headless argument echo is byte-faithful to ~700B on
# Flash — above ~1KB the model's own transcription of verbatim literals fails
# (a model ceiling, not renderer truncation). No case may lean on >~1KB
# verbatim tool-argument transcription on Flash.

cd "$(dirname "$0")" || exit 1
# shellcheck source=lib.sh
source ./lib.sh

OUT="$(artifacts_dir technical)"
export PRESERVE_DIR="$OUT"   # consumed by lib.sh's preserve_run

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
if [ $KEEP -eq 1 ]; then : > "$OUT/keep.flag"; fi

cleanup() { e2e_teardown technical; }
trap cleanup EXIT
e2e_on_signal() {
  note "caught INT/TERM — stopping the suite and cleaning up"
  cleanup
  exit 130
}
trap e2e_on_signal INT TERM

# Per-turn watchdog seconds, overridable for a degraded provider (each turn is
# one `opencode run` process; a slow provider needs a bigger ceiling, a fast one
# never waits it out).
TURN_SECS="${E2E_TURN_SECS:-600}"

# opencode run with a watchdog: capture output to a file, never hang the suite.
# After SIGTERM the process gets a 10s grace to exit on its own — a provider
# stall can leave it ignoring SIGTERM, and an unbounded `wait` there hangs the
# whole suite — so SIGKILL finishes the job before wait.
oc_run_capture() { # FILE SECONDS args...
  local out="$1" secs="$2"; shift 2
  opencode run --auto "$@" >"$out" 2>&1 &
  local pid=$!
  manifest_pid "$pid" "opencode run --auto $*"
  local deadline=$((SECONDS + secs))
  while kill -0 "$pid" 2>/dev/null && [ $SECONDS -lt $deadline ]; do sleep 2; done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 5); do kill -0 "$pid" 2>/dev/null || break; sleep 2; done
    kill -9 "$pid" 2>/dev/null || true
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

# Reclaim prior-run orphans before anything of this run exists (#44); the
# reaper forks right after the scratch exists, so it can tear it down if this
# script dies any way its traps cannot handle.
e2e_startup_sweep

section "setup"
scratch_new
e2e_start_reaper technical
note "scratch: $SCRATCH"
build_plugin && ok "plugin built (dist/ fresh)" || { bad "plugin build failed"; finish; exit 1; }

section "T0 — model sanity (auth + default model reach the provider)"
oc_run_capture "$OUT/t0.out" "$TURN_SECS" "Reply with exactly the word READY." || true
grep -q "READY" "$OUT/t0.out" \
  && ok "model answered in scratch env" \
  || { bad "model did not answer in scratch env" "see $OUT/t0.out — auth symlink or provider config broken; aborting"; finish; exit 1; }

section "T2 — parallel fan-out (3 agents, barrier, journal)"
# First heavyweight case after the slimming (#45): its failure is the suite's
# triage canary. A schema-forced agent can die on a transient provider
# api-error (schema-forced $ref against the Together grammar, README:295-300);
# the parallel barrier and the journal are the contract — a missing answer is
# provider weather only when the missing agent's journal entry records it.
runs_snapshot "$OUT/runs-before-t2.txt"
oc_run_capture "$OUT/t2.out" "$((TURN_SECS * 2))" "$(wf_prompt parallel)" || true
RUN2="$(newest_completed_run "$OUT/runs-before-t2.txt")"
preserve_run "$RUN2"
if [ -n "$RUN2" ]; then
  ok "run dir created: $RUN2"
  assert_run_completed "$RUN2"
  T2_LABELS="$(python3 - "$RUN_ROOT/$RUN2/journal.jsonl" <<'PYEOF'
import json, sys
labels = set()
for line in open(sys.argv[1]):
    try: e = json.loads(line)
    except Exception: continue
    if isinstance(e.get("label"), str): labels.add(e["label"])
print(len(labels))
PYEOF
)"
  [ "$T2_LABELS" = "3" ] && ok "journal covers exactly 3 agents" \
    || bad "journal has $T2_LABELS distinct agent labels, expected 3" "a stall restart writes another entry for the same key; the distinct-label count is the invariant"
  if result_json_has "$RUN2" 'len(d.get("answers", [])) == 3'; then
    ok "3 answers returned"
    # Re-homed from T1 (#45): the schema answer must be a non-empty string.
    result_json_has "$RUN2" 'all(isinstance(a, str) and a.strip() for a in d["answers"])' \
      && ok "schema-forced answers non-empty" \
      || bad "schema-forced answer missing/empty" "inspect $RUN2/result.json"
  else
    T2_MISSING_ERR="$(python3 - "$RUN_ROOT/$RUN2/journal.jsonl" <<'PYEOF'
import json, sys
labels, err_labels = set(), set()
for line in open(sys.argv[1]):
    try: e = json.loads(line)
    except Exception: continue
    label = e.get("label")
    if not isinstance(label, str): continue
    labels.add(label)
    if e.get("reason") == "api-error": err_labels.add(label)
missing = {"fanout:1", "fanout:2", "fanout:3"} - labels
print(1 if missing and missing <= err_labels else 0)
PYEOF
)"
    if result_json_has "$RUN2" 'len(d.get("answers", [])) == 2' && [ "$T2_MISSING_ERR" = "1" ]; then
      note "2/3 answers returned; the missing agent's journal entry records the provider api-error flake"
      ok "answers returned (modulo provider flake)"
    else
      bad "answers != 3 and the missing agent recorded no api-error" "inspect $RUN2"
    fi
  fi
else
  bad "no completed run dir" "first-heavyweight canary — see $OUT/t2.out (watchdog kills print there)"
fi

section "T3 — resume across processes (T2's run replayed, zero live agents)"
# Slimmed to a resume-only turn consuming T2's completed run (#45; shape
# live-proven in #54). Pins: this -c resume is the turn IMMEDIATELY after T2 —
# no intervening session-creating command — with parallel.js passed verbatim
# and no args on either call; the manifest hash equality below is the cheap
# model-independent guard that those pins held. T2's dir is preserved in the
# T2 section, so both sides of the pair survive teardown.
if [ -z "$RUN2" ]; then
  bad "T3 has no baseline: T2 produced no completed run" "the slimmed resume chain consumes T2's run — fix T2 first"
else
  runs_snapshot "$OUT/runs-before-t3.txt"
  oc_run_capture "$OUT/t3.out" "$TURN_SECS" -c "$(wf_prompt parallel "Set resumeFromRunId to $RUN2.")" || true
  if [ -z "$(newest_completed_run "$OUT/runs-before-t3.txt")" ]; then
    note "first resume attempt settled short — retrying once"
    oc_run_capture "$OUT/t3b.out" "$TURN_SECS" -c "$(wf_prompt parallel "Set resumeFromRunId to $RUN2.")" || true
  fi
  RUN3="$(newest_run "$OUT/runs-before-t3.txt")"
  preserve_run "$RUN3"
  if [ -n "$RUN3" ]; then
    ok "resume run dir created: $RUN3"
    assert_run_completed "$RUN3"
    T3_HASH_GUARD="$(python3 - "$RUN_ROOT/$RUN2/manifest.json" "$RUN_ROOT/$RUN3/manifest.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
print(1 if a.get("sourceHash") == b.get("sourceHash") and a.get("argsHash") == b.get("argsHash") else 0)
PYEOF
)"
    if [ "$T3_HASH_GUARD" = "1" ]; then
      ok "resumed manifest hashes equal the baseline's (script verbatim, no args)"
    else
      bad "resumed manifest hashes differ from the baseline's" "the verbatim/no-args pins failed — compare both manifests"
    fi
    # Replay asserts hold in full only on an all-ok baseline: the engine
    # replays only ok entries and re-runs failed calls live on resume, so
    # all-replayed and result equality cannot hold across a degenerate
    # (2/3 + api-error) baseline — that path degrades to a note (#54).
    T3_BASE_OK="$(python3 - "$RUN_ROOT/$RUN2/journal.jsonl" <<'PYEOF'
import json, sys
entries = []
for line in open(sys.argv[1]):
    try: entries.append(json.loads(line))
    except Exception: continue
print(1 if entries and all(e.get("status") == "ok" for e in entries) else 0)
PYEOF
)"
    T3_ALL_REPLAYED="$(python3 - "$RUN_ROOT/$RUN3/journal.jsonl" <<'PYEOF'
import json, sys
entries = []
for line in open(sys.argv[1]):
    try: entries.append(json.loads(line))
    except Exception: continue
print(1 if entries and all(e.get("replayed") is True for e in entries) else 0)
PYEOF
)"
    T3_NO_CHILDREN="$(python3 - "$RUN_ROOT/$RUN3/manifest.json" <<'PYEOF'
import json, sys
print(1 if json.load(open(sys.argv[1])).get("childSessionIDs") == [] else 0)
PYEOF
)"
    if [ "$T3_BASE_OK" = "1" ]; then
      [ "$T3_ALL_REPLAYED" = "1" ] \
        && ok "every journal entry replayed from $RUN2 (zero live agents)" \
        || bad "a resume journal entry did not replay" "inspect $OUT/$RUN3/journal.jsonl"
      [ "$T3_NO_CHILDREN" = "1" ] \
        && ok "resume spawned no child session (childSessionIDs == [])" \
        || bad "resume spawned child sessions" "inspect $RUN3/manifest.json"
      T3_FIDELITY="$(python3 - "$RUN_ROOT/$RUN2/result.json" "$RUN_ROOT/$RUN3/result.json" <<'PYEOF'
import json, sys
try:
    a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
except Exception:
    print(0); raise SystemExit
print(1 if a == b else 0)
PYEOF
)"
      [ "$T3_FIDELITY" = "1" ] \
        && ok "resumed result equals the recorded baseline value (replay fidelity)" \
        || bad "resumed result differs from the recorded baseline value" "baseline: $(cat "$RUN_ROOT/$RUN2/result.json" 2>/dev/null) — resumed: $(cat "$RUN_ROOT/$RUN3/result.json" 2>/dev/null)"
    else
      note "T2's journal was degenerate ($(journal_grep "$RUN2" '"status":"ok"') of $(journal_count "$RUN2") entries ok) — only ok entries replay, so all-replayed and fidelity degrade to a note (#54)"
      [ "$(journal_grep "$RUN3" '"replayed":true')" -ge 1 ] \
        && ok "the ok baseline entries replayed" \
        || note "no replayed entry under a degenerate baseline — inspect $OUT/$RUN3/journal.jsonl"
    fi
  else
    bad "resume produced no run dir" "see $OUT/t3.out"
  fi
fi

section "T4 — nested workflow({script})"
runs_snapshot "$OUT/runs-before-t4.txt"
oc_run_capture "$OUT/t4.out" "$TURN_SECS" "$(wf_prompt nested)" || true
if [ -z "$(newest_completed_run "$OUT/runs-before-t4.txt")" ]; then
  note "first attempt stalled or failed — retrying once"
  oc_run_capture "$OUT/t4b.out" "$TURN_SECS" "$(wf_prompt nested)" || true
fi
T4_RUNS="$(runs_new_since "$OUT/runs-before-t4.txt")"
for r in $T4_RUNS; do preserve_run "$r"; done
RUN4="$(newest_completed_run "$OUT/runs-before-t4.txt")"
T4_COUNT="$(printf '%s' "$T4_RUNS" | grep -c . || true)"
if [ -n "$RUN4" ]; then
  [ "$T4_COUNT" -eq 1 ] && ok "one run dir (nested runs share the parent's, by design)" \
    || note "$T4_COUNT run dirs (outer model retried); asserting on the completed one"
  assert_run_completed "$RUN4"
  # The INNER grep row was removed (#45): it matched the tool-argument echo,
  # not results (echo-satisfiable). The nesting property survives without it —
  # a broken nested call throws and the run cannot complete.
else
  bad "no completed run dir" "see $OUT/t4.out"
fi

section "T5 — saved workflow by name + unknown-name error (one merged turn)"
# T5a+T5b merged (#45; shape live-proven in #54): one script try/catches the
# unknown-name sync throw, then calls the saved name. Both facts are
# result.json-assertable, replacing the echo-grade greps; the caught throw
# creates no run dir — the named call shares the parent's. The saved probe.js
# fixture stays.
mkdir -p "$SCRATCH/project/.opencode/ultraopen/workflows"
cat > "$SCRATCH/project/.opencode/ultraopen/workflows/probe.js" <<'PROBE'
export const meta = { name: 'probe', description: 'Saved workflow probe' }
return 'SAVED-WORKFLOW-RAN'
PROBE
t5_prompt() {
  printf 'Call the workflow tool now. Pass no scriptPath and no args. Use this script exactly, unchanged:\n\n%s\n\nThe tool returns a launch result with a run id, not the outcome. Then call workflow_status with that run id and wait=120 (repeat the call if it says running). When the status is completed or failed, reply with what workflow_status reported — the value or the failure. Never end your turn while the run is unsettled.' \
    "$(cat <<'T5SCRIPT'
export const meta = { name: 'e2e-merged-t5', description: 'Try/catch the unknown-name throw, then run the saved name', phases: [{ title: 'Probe' }] }
let caught = null
try {
  await workflow('definitely-not-saved')
} catch (e) {
  caught = { name: e && e.name, message: e && e.message ? e.message : String(e) }
}
const saved = await workflow('probe')
return { caught, saved }
T5SCRIPT
)"
}
runs_snapshot "$OUT/runs-before-t5.txt"
oc_run_capture "$OUT/t5.out" "$TURN_SECS" "$(t5_prompt)" || true
if [ -z "$(newest_completed_run "$OUT/runs-before-t5.txt")" ]; then
  note "first attempt produced no completed run — retrying once"
  oc_run_capture "$OUT/t5b.out" "$TURN_SECS" "$(t5_prompt)" || true
fi
RUN5="$(newest_run "$OUT/runs-before-t5.txt")"
T5_RUNS="$(runs_new_since "$OUT/runs-before-t5.txt" | grep -c . || true)"
preserve_run "$RUN5"
if [ -n "$RUN5" ]; then
  [ "$T5_RUNS" -eq 1 ] \
    && ok "one run dir (the caught throw registered none; the named call shares the parent's)" \
    || note "$T5_RUNS run dirs (outer model retried); asserting on the newest"
  if [ "$(manifest_status "$RUN5")" = "completed" ]; then
    ok "merged turn completed (the caught throw did not fail the run)"
    result_json_has "$RUN5" 'isinstance(d.get("caught"), dict) and ("No saved workflow named " + chr(34) + "definitely-not-saved" + chr(34) + ".") in (d["caught"].get("message") or "")' \
      && ok "the unknown-name error is result.json-assertable (caught.message)" \
      || bad "caught.message does not name the unknown-workflow error" "inspect $RUN5/result.json"
    result_json_has "$RUN5" 'd.get("saved") == "SAVED-WORKFLOW-RAN"' \
      && ok "the saved workflow ran by name and returned its value" \
      || bad "the named call did not return the saved workflow's value" "inspect $RUN5/result.json"
  else
    bad "the merged T5 run did not complete" "manifest $(manifest_status "$RUN5") — inspect $OUT/$RUN5 and $OUT/t5.out"
  fi
else
  bad "the merged T5 probe produced no run dir" "see $OUT/t5.out"
fi

section "T6 — hydration: a settled background run delivers its result to the parent mid-turn"
# The detached run settles while the parent turn is still in flight (the model
# is inside a workflow_status wait). The plugin hydrates the parent session with
# a synthetic `<workflow-completed>` notification (ticket #7); the in-flight
# loop re-reads messages each step, so the notification reaches the model and
# it answers. Two proofs: the notification EXISTS in the parent transcript
# (the scratch opencode.db, deterministic) and the model replies to it (the
# exact ack from the prompt, the T0-style echo contract).
t6_prompt() {
  printf 'Call the workflow tool now. Pass no scriptPath and no args. Use this script exactly, unchanged:\n\n%s\n\nThe tool returns a launch result with a run id, not the outcome. Then call workflow_status with that run id and wait=120 (repeat the call if it says running). A workflow-completed notification will arrive in this conversation when the run settles. When it arrives, reply with exactly HYDRA-ACK-7391 and nothing else. Never end your turn while the run is unsettled.' \
    "$(cat "$E2E_DIR/fixtures/hydration.js")"
}
runs_snapshot "$OUT/runs-before-t6.txt"
oc_run_capture "$OUT/t6.out" "$TURN_SECS" "$(t6_prompt)" || true
RUN6="$(newest_completed_run "$OUT/runs-before-t6.txt")"
preserve_run "$RUN6"
if [ -n "$RUN6" ]; then
  assert_run_completed "$RUN6"
  t6_notification() {
    python3 - "$XDG_DATA_HOME/opencode/opencode.db" "$RUN6" <<'PYEOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
# The part text lives inside JSON, so the quotes around the run id are
# backslash-escaped in the stored bytes — the pattern must not anchor on them.
row = db.execute(
    "SELECT data FROM part WHERE data LIKE ? AND data LIKE ? LIMIT 1",
    ('%"synthetic":true%', f'%workflow-completed run=%{sys.argv[2]}%'),
).fetchone()
sys.exit(0 if row else 1)
PYEOF
  }
  if t6_notification; then
    ok "the synthetic workflow-completed notification is in the parent transcript"
  else
    bad "no synthetic notification for $RUN6 in the transcript db" "inspect $SCRATCH/share/opencode/opencode.db"
  fi
  grep -q "HYDRA-ACK-7391" "$OUT/t6.out" \
    && ok "the model responded to the notification" \
    || bad "the model never acknowledged the notification" "see $OUT/t6.out"
else
  bad "the hydration probe produced no completed run dir" "see $OUT/t6.out"
fi

section "T6b — stop path: workflow({stop}) aborts a live detached run and records it cancelled"
# The run has three real model calls, so it is still live when the parent makes
# the stop call in the same turn. Proofs: the stop tool result reports the stop
# (workflow-stopped), the manifest is cancelled with NO result.json (a cancelled
# record never settles a result), the synthetic workflow-stopped confirmation is
# in the parent transcript (the hydration half of the stop contract), and
# workflow_status reports cancelled (issue #10).
t6b_prompt() {
  printf 'Call the workflow tool now. Pass no scriptPath and no args. Use this script exactly, unchanged:\n\n%s\n\nThe tool returns a launch result with a run id, not the outcome. Call the workflow tool AGAIN immediately after, passing ONLY the stop argument with that run id (no script, no scriptPath, no args). The stop result will describe what happened. Then call workflow_status with that run id and wait=120 and reply with the status it reported. Never end your turn while the run is unsettled.' \
    "$(cat "$E2E_DIR/fixtures/stop.js")"
}
runs_snapshot "$OUT/runs-before-t6b.txt"
oc_run_capture "$OUT/t6b.out" "$TURN_SECS" "$(t6b_prompt)" || true
RUN6B="$(newest_run "$OUT/runs-before-t6b.txt")"
preserve_run "$RUN6B"
if [ -n "$RUN6B" ]; then
  if [ "$(manifest_status "$RUN6B")" = "cancelled" ]; then
    ok "the stopped run's manifest is cancelled"
  elif [ "$(manifest_status "$RUN6B")" = "completed" ]; then
    note "the run completed before the stop landed (fast provider) — retrying once"
    runs_snapshot "$OUT/runs-before-t6b2.txt"
    oc_run_capture "$OUT/t6b2.out" "$TURN_SECS" "$(t6b_prompt)" || true
    RUN6B="$(newest_run "$OUT/runs-before-t6b2.txt")"
    preserve_run "$RUN6B"
    if [ -n "$RUN6B" ] && [ "$(manifest_status "$RUN6B")" = "cancelled" ]; then
      ok "the stopped run's manifest is cancelled (retry)"
    else
      bad "the stop probe produced no cancelled manifest" "see $OUT/t6b*.out"
    fi
  else
    bad "the stop probe run did not cancel" "manifest $(manifest_status "$RUN6B") — inspect $OUT/$RUN6B and $OUT/t6b.out"
  fi
  if [ -n "$RUN6B" ] && [ "$(manifest_status "$RUN6B")" = "cancelled" ]; then
    [ ! -f "$RUN_ROOT/$RUN6B/result.json" ] \
      && ok "a cancelled run has no result.json (the stop path settles the manifest alone)" \
      || bad "a cancelled run invented a result.json" "inspect $RUN_ROOT/$RUN6B"
    t6b_notification() {
      python3 - "$XDG_DATA_HOME/opencode/opencode.db" "$RUN6B" <<'PYEOF'
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
row = db.execute(
    "SELECT data FROM part WHERE data LIKE ? AND data LIKE ? LIMIT 1",
    ('%"synthetic":true%', f'%workflow-stopped run=%{sys.argv[2]}%'),
).fetchone()
sys.exit(0 if row else 1)
PYEOF
    }
    if t6b_notification; then
      ok "the synthetic workflow-stopped confirmation is in the parent transcript"
    else
      bad "no synthetic workflow-stopped notification for $RUN6B in the transcript db" "inspect $SCRATCH/share/opencode/opencode.db"
    fi
    grep -q "cancelled" "$OUT/t6b.out" \
      && ok "workflow_status reported the run cancelled to the model" \
      || bad "the model's reply never reported cancelled" "see $OUT/t6b.out"
  fi
else
  bad "the stop probe produced no run dir" "see $OUT/t6b.out"
fi

section "T7 — agentDeadlineMs option (tuple-form options reach the engine)"
scratch_write_config '{"agentDeadlineMs": 1}'
runs_snapshot "$OUT/runs-before-t7.txt"
oc_run_capture "$OUT/t7.out" "$TURN_SECS" "$(wf_prompt smoke)" || true
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

section "T10 — concurrent launches in one ultracode session (the live-run cap admits two)"
# The conditional gate (docs/adr/0001-launch-concurrency-policy.md): an
# ultracode-active session launches TWO workflows back to back in one turn. The
# sibling advisory in the second launch result is the registry-level proof the
# gate saw two live runs; the overlapping manifest windows are the disk proof.
# The load-bearing case after the slimming (#45): sole e2e prover of keyword
# activation, per-id status, admission, replay ×2, and value delivery — its
# two resume turns carry pinned harness retries.
t10_prompt() {
  printf 'ultracode Call the workflow tool TWICE, both calls in ONE step: emit the two tool calls together in a single response, never one after another across steps. Both calls use background true, no scriptPath, no args, and this script exactly, unchanged:\n\n%s\n\nAfter BOTH launch results arrive, call workflow_status for EACH of the two run ids (wait=120, repeat while any report says running). When both are settled, reply with both run ids and their final statuses. Never end your turn while any run is unsettled.' \
    "$(cat "$E2E_DIR/fixtures/ping.js")"
}
# launch_ids FILE — distinct run ids of successful launches in a --format json stream
launch_ids() {
  python3 - "$1" <<'PYEOF'
import json, re, sys
ids = []
for line in open(sys.argv[1]):
    try: event = json.loads(line)
    except Exception: continue
    part = event.get("part") or {}
    if event.get("type") in ("tool", "tool_use") and part.get("tool") == "workflow":
        ids += re.findall(r'workflow-launched run="(wf_[a-f0-9]+)"', (part.get("state") or {}).get("output") or "")
print("\n".join(dict.fromkeys(ids)))
PYEOF
}
runs_snapshot "$OUT/runs-before-t10.txt"
oc_run_capture "$OUT/t10.json" "$((TURN_SECS + TURN_SECS / 2))" --format json "ultracode $(t10_prompt)" || true
if grep -q "Sibling runs still live in this session" "$OUT/t10.json"; then
  ok "second launch went through while the first was live (sibling advisory rendered)"
else
  note "first attempt did not produce a concurrent pair (model polled between launches or provider stall) — retrying once"
  runs_snapshot "$OUT/runs-before-t10b.txt"
  oc_run_capture "$OUT/t10b.json" "$((TURN_SECS + TURN_SECS / 2))" --format json "ultracode $(t10_prompt)" || true
  if grep -q "Sibling runs still live in this session" "$OUT/t10b.json"; then
    ok "retry: the second launch went through while the first was live"
  else
    bad "no concurrent pair in either attempt" "the ultracode gate must admit a second live launch — see $OUT/t10.json and $OUT/t10b.json"
  fi
fi
# Assert on whichever attempt produced the concurrent pair (the retry if present).
T10_FILE="$OUT/t10.json"
if [ -f "$OUT/t10b.json" ] && grep -q "Sibling runs still live in this session" "$OUT/t10b.json"; then
  T10_FILE="$OUT/t10b.json"
fi
T10_IDS="$(launch_ids "$T10_FILE")"
T10_COUNT="$(printf '%s' "$T10_IDS" | grep -c . || true)"
if [ "$T10_COUNT" -eq 2 ]; then
  ok "two distinct run ids launched from one ultracode session"
else
  bad "expected 2 distinct run ids, got: $(printf '%s' "$T10_IDS" | tr '\n' ' ')" "see $T10_FILE"
fi
# The advisory is tied to the launch results, not the stream at large: every
# sibling line must sit inside a launch result and name the OTHER run, and at
# least one launch result must carry it.
T10_TIED="$(python3 - "$T10_FILE" <<'PYEOF'
import json, re, sys
launch_pairs = []
for line in open(sys.argv[1]):
    try: event = json.loads(line)
    except Exception: continue
    part = event.get("part") or {}
    if event.get("type") in ("tool", "tool_use") and part.get("tool") == "workflow":
        out = (part.get("state") or {}).get("output") or ""
        m = re.search(r'workflow-launched run="(wf_[a-f0-9]+)"', out)
        if m: launch_pairs.append((m.group(1), out))
ids = {pair[0] for pair in launch_pairs}
advised = []
for own, out in launch_pairs:
    if "Sibling runs still live in this session" in out:
        named = set(re.findall(r"wf_[a-f0-9]+", out.split("Sibling runs still live in this session", 1)[1].split("</workflow-launched>", 1)[0]))
        if named and named <= ids and own not in named:
            advised.append(own)
print(1 if len(launch_pairs) >= 2 and advised else 0)
PYEOF
)"
if [ "$T10_TIED" = "1" ]; then
  ok "a launch result names its sibling live run by id"
else
  bad "no launch result tied the sibling advisory to a launched run id" "see $T10_FILE"
fi
T10_A="$(printf '%s' "$T10_IDS" | sed -n 1p)"
T10_B="$(printf '%s' "$T10_IDS" | sed -n 2p)"
for r in $T10_A $T10_B; do preserve_run "$r"; done
if [ "$(manifest_status "$T10_A")" = "missing" ] || [ "$(manifest_status "$T10_B")" = "missing" ]; then
  bad "a launched run has no manifest on disk" "$T10_A, $T10_B"
fi
# Two facts about the pair of manifests: same-session (1/0) and overlapping
# live windows (1/0). Overlap is the disk-level concurrency proof.
T10_MANIFEST_FACTS="$(python3 - "$RUN_ROOT/$T10_A/manifest.json" "$RUN_ROOT/$T10_B/manifest.json" <<'PYEOF'
import json, sys
a, b = (json.load(open(path)) for path in sys.argv[1:3])
sa, ea = a.get("startedAt", 0), a.get("endedAt", 0)
sb, eb = b.get("startedAt", 0), b.get("endedAt", 0)
same = 1 if a.get("sessionID") == b.get("sessionID") and a.get("sessionID") else 0
overlap = 1 if (sa <= eb and sb <= ea and ea and eb) else 0
print(f"{same} {overlap}")
PYEOF
)" 2>/dev/null || T10_MANIFEST_FACTS="0 0"
if [ "${T10_MANIFEST_FACTS%% *}" = "1" ]; then
  ok "both runs share one session (the cap is per session)"
else
  bad "the two runs do not share one session" "manifests: $T10_A, $T10_B"
fi
if [ "${T10_MANIFEST_FACTS##* }" = "1" ]; then
  ok "manifest windows overlap — both runs were live at the same time"
else
  bad "no overlap between the two runs' windows" "A: $T10_A, B: $T10_B"
fi
if [ "$(manifest_status "$T10_A")" = "completed" ] && [ "$(manifest_status "$T10_B")" = "completed" ]; then
  ok "both runs settled completed independently"
else
  bad "both runs must settle completed" "A: $(manifest_status "$T10_A"), B: $(manifest_status "$T10_B")"
fi
# workflow_status reports each run by its own id: the stream must contain a poll
# naming run A and one naming run B.
T10_POLLED="$(python3 - "$T10_FILE" "$T10_A" "$T10_B" <<'PYEOF'
import json, re, sys
file, a, b = sys.argv[1:4]
polled = set()
for line in open(file):
    try: event = json.loads(line)
    except Exception: continue
    part = event.get("part") or {}
    if event.get("type") in ("tool", "tool_use") and part.get("tool") == "workflow_status":
        run_id = ((part.get("state") or {}).get("input") or {}).get("runId") or ""
        text = (part.get("state") or {}).get("output") or ""
        polled.update(re.findall(r'workflow-status run="(wf_[a-f0-9]+)"', text))
        if run_id_match := re.match(r"(wf_[a-f0-9]+)", run_id):
            polled.add(run_id_match.group(1))
print(1 if a in polled and b in polled else 0)
PYEOF
)" || T10_POLLED=0
if [ "$T10_POLLED" = "1" ]; then
  ok "workflow_status reported each run by its own id"
else
  bad "the turn did not poll both run ids through workflow_status" "see $T10_FILE"
fi
# Value delivery, re-homed from T9 (#45): the launch result never carries the
# outcome — the value reaches the model only through a workflow_status poll.
# The sound anchor is a tool RESULT: a workflow_status event whose output
# carries the run's value (PING). The stream's tool-argument echo is the
# argument channel, not results (the removed T9 grep matched that echo).
T10_DELIVERED="$(python3 - "$T10_FILE" <<'PYEOF'
import json, sys
hit = 0
for line in open(sys.argv[1]):
    try: event = json.loads(line)
    except Exception: continue
    part = event.get("part") or {}
    if event.get("type") in ("tool", "tool_use") and part.get("tool") == "workflow_status":
        if "PING" in ((part.get("state") or {}).get("output") or ""):
            hit = 1
print(hit)
PYEOF
)" || T10_DELIVERED=0
if [ "$T10_DELIVERED" = "1" ]; then
  ok "final value delivered through the status poll (a workflow_status result carried PING)"
elif [ "$(manifest_status "$T10_A")" = "completed" ] && [ "$(manifest_status "$T10_B")" = "completed" ]; then
  note "both runs settled completed but no workflow_status result carried the value — the provider's degenerate empty-completion flake (0 tokens, status ok); inspect $T10_FILE"
else
  bad "no workflow_status result carried the run's value" "the poll must deliver it — see $T10_FILE"
fi
# Each run delivered a settled agent result in its own journal. The VALUE's
# text is provider weather — the provider can return an empty completion (0
# tokens, status ok) — so an empty journal value is a note, not a failure.
T10_VALUES="$(python3 - "$RUN_ROOT/$T10_A/journal.jsonl" "$RUN_ROOT/$T10_B/journal.jsonl" <<'PYEOF'
import json, sys
oks = 0
for path in sys.argv[1:3]:
    try:
        ok = any(json.loads(line).get("status") == "ok" for line in open(path))
    except Exception:
        ok = False
    oks += 1 if ok else 0
print(oks)
PYEOF
)" || T10_VALUES=0
if [ "$T10_VALUES" = "2" ]; then
  ok "each run delivered a settled agent result"
  if [ "$(journal_grep "$T10_A" "PING")" -ge 1 ] && [ "$(journal_grep "$T10_B" "PING")" -ge 1 ]; then
    ok "each run delivered its own value"
  else
    note "one run's agent value was empty — the provider's degenerate empty-completion flake (0 tokens, status ok)"
  fi
else
  bad "a concurrent run's journal lacks its result entry" "inspect $T10_A and $T10_B"
fi
# Both settled runs are resumable: -c continues the ultracode session, and each
# resume replays its run's journal with zero live agents. T10 is the
# load-bearing case, so its two resume turns carry pinned harness retries (#45).
runs_snapshot "$OUT/runs-before-t10r1.txt"
oc_run_capture "$OUT/t10r1.out" "$TURN_SECS" -c "$(wf_prompt ping "Set resumeFromRunId to $T10_A.")" || true
if [ -z "$(newest_completed_run "$OUT/runs-before-t10r1.txt")" ]; then
  note "resume of run A settled short — retrying once"
  oc_run_capture "$OUT/t10r1b.out" "$TURN_SECS" -c "$(wf_prompt ping "Set resumeFromRunId to $T10_A.")" || true
fi
R10A="$(newest_run "$OUT/runs-before-t10r1.txt")"
preserve_run "$R10A"
if [ -n "$R10A" ]; then
  assert_run_completed "$R10A"
  [ "$(journal_grep "$R10A" '"replayed":true')" -ge 1 ] \
    && ok "concurrent run A resumable after settle (journal replayed)" \
    || bad "resume of run A did not replay" "inspect $OUT/$R10A/journal.jsonl"
else
  bad "resume of run A produced no run dir" "see $OUT/t10r1.out"
fi
runs_snapshot "$OUT/runs-before-t10r2.txt"
oc_run_capture "$OUT/t10r2.out" "$TURN_SECS" -c "$(wf_prompt ping "Set resumeFromRunId to $T10_B.")" || true
if [ -z "$(newest_completed_run "$OUT/runs-before-t10r2.txt")" ]; then
  note "resume of run B settled short — retrying once"
  oc_run_capture "$OUT/t10r2b.out" "$TURN_SECS" -c "$(wf_prompt ping "Set resumeFromRunId to $T10_B.")" || true
fi
R10B="$(newest_run "$OUT/runs-before-t10r2.txt")"
preserve_run "$R10B"
if [ -n "$R10B" ]; then
  assert_run_completed "$R10B"
  [ "$(journal_grep "$R10B" '"replayed":true')" -ge 1 ] \
    && ok "concurrent run B resumable after settle (journal replayed)" \
    || bad "resume of run B did not replay" "inspect $OUT/$R10B/journal.jsonl"
else
  bad "resume of run B produced no run dir" "see $OUT/t10r2.out"
fi

section "T11 — a non-ultracode session still refuses its second launch end-to-end"
# Both calls are demanded in ONE step: the first launch registers a pending
# entry synchronously, so the second call is refused while it is still pending.
# On Flash the premise is weather, not determinism: the model can split the
# calls across steps, and a ping run settles in seconds — a first run that
# settles before the second launch arrives is correctly ADMITTED (the gate
# drops settled entries at once, src/server/tool/background.ts), so the
# refusal never renders. One retry tolerates that split, mirroring T10's
# handling of the same weather class; the refusal assert itself stays hard.
t11_prompt() {
  wf_prompt ping "Call the workflow tool TWICE in ONE step: emit the two tool calls together in a single response, both with background true, no scriptPath, no args, and this script exactly, unchanged. The second call is expected to be refused — that is the point of this exercise. After both results arrive, call workflow_status for the run id that DID launch (wait=120, repeat while it says running) and reply with what it reported."
}
runs_snapshot "$OUT/runs-before-t11.txt"
oc_run_capture "$OUT/t11.json" "$TURN_SECS" --format json "$(t11_prompt)" || true
if ! grep -q "already has a workflow run in flight" "$OUT/t11.json"; then
  note "first attempt produced no refusal (model split the one-step demand, or the first run settled first) — retrying once"
  oc_run_capture "$OUT/t11b.json" "$TURN_SECS" --format json "$(t11_prompt)" || true
fi
# Assert on whichever attempt produced the refusal (the retry if present).
T11_FILE="$OUT/t11.json"
if [ -f "$OUT/t11b.json" ] && grep -q "already has a workflow run in flight" "$OUT/t11b.json"; then
  T11_FILE="$OUT/t11b.json"
fi
if grep -q "already has a workflow run in flight" "$T11_FILE"; then
  ok "the second launch was refused with the one-live-run refusal"
else
  bad "no refusal in either attempt" "the plain one-live-run gate must hold — see $OUT/t11.json and $OUT/t11b.json"
fi
T11_CREATED="$(runs_new_since "$OUT/runs-before-t11.txt" | grep -c . || true)"
if [ "$T11_CREATED" = "1" ]; then
  ok "exactly one run dir was created (the refused call registered nothing)"
else
  note "$T11_CREATED run dirs for the non-ultracode turn (model retries create more); asserting the refusal only"
fi
T11_RUN="$(newest_run "$OUT/runs-before-t11.txt")"
preserve_run "$T11_RUN"
if [ -n "$T11_RUN" ] && [ "$(manifest_status "$T11_RUN")" = "completed" ]; then
  ok "the single admitted run settled completed"
else
  bad "the admitted run did not settle" "manifest: $(manifest_status "$T11_RUN")"
fi

[ -f "$DATA_ROOT/log/opencode.log" ] && cp "$DATA_ROOT/log/opencode.log" "$OUT/server.log" 2>/dev/null || true
finish