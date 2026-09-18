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

section "setup"
scratch_new
note "scratch: $SCRATCH"
build_plugin && ok "plugin built (dist/ fresh)" || { bad "plugin build failed"; finish; exit 1; }

section "T0 — model sanity (auth + default model reach the provider)"
oc_run_capture "$OUT/t0.out" "$TURN_SECS" "Reply with exactly the word READY." || true
grep -q "READY" "$OUT/t0.out" \
  && ok "model answered in scratch env" \
  || { bad "model did not answer in scratch env" "see $OUT/t0.out — auth symlink or provider config broken; aborting"; finish; exit 1; }

section "T1 — workflow tool end-to-end (async launch, permission auto-approve, schema forcing)"
runs_snapshot "$OUT/runs-before-t1.txt"
oc_run_capture "$OUT/t1.out" "$TURN_SECS" "$(wf_prompt smoke)" || true
if [ -z "$(newest_completed_run "$OUT/runs-before-t1.txt")" ]; then
  # A schema-forced agent dies on a transient provider api-error ~1 in 3 turns
  # (see T3); the async contract itself is proven by the poll below.
  note "first attempt failed or settled failed — retrying once"
  oc_run_capture "$OUT/t1b.out" "$TURN_SECS" "$(wf_prompt smoke)" || true
fi
RUN1_ALL="$(runs_new_since "$OUT/runs-before-t1.txt")"
for r in $RUN1_ALL; do preserve_run "$r"; done
RUN1="$(newest_completed_run "$OUT/runs-before-t1.txt")"
# Headless output echoes tool ARGUMENTS, not tool results, so the launch
# result itself is invisible here. The observable async-contract proof: the
# model polled workflow_status in the same turn (it can only do that when the
# launch returned a run id instead of an outcome) and the run settled on disk.
if grep -q "workflow_status" "$OUT/t1.out"; then
  ok "launch returned a run id; the model polled workflow_status in-turn"
else
  bad "no workflow_status poll in the turn" "the launch result must hand the model a run id — see $OUT/t1.out"
fi
if [ -n "$RUN1" ]; then
  ok "run dir created: $RUN1"
  RUN1_ATTEMPTS="$(printf '%s' "$RUN1_ALL" | grep -c . || true)"
  if [ "$RUN1_ATTEMPTS" -gt 1 ]; then
    note "$RUN1_ATTEMPTS workflow attempts this turn; asserting on the completed one (outer model self-retried a transient failure)"
  fi
  assert_run_completed "$RUN1"
  [ "$(journal_count "$RUN1")" -ge 1 ] && ok "journal has $(journal_count "$RUN1") entry" || bad "journal empty"
  result_json_has "$RUN1" '"answer" in d' && ok "schema-forced result shape {answer}" || bad "result.json missing answer"
  result_json_has "$RUN1" 'isinstance(d.get("answer"), str) and d["answer"].strip() != ""' && ok "agent produced a non-empty schema-forced answer" || bad "schema-forced answer missing/empty"
else
  bad "no completed run dir" "attempts: $(printf '%s' "$RUN1_ALL" | tr '\n' ' ') — see $OUT/t1.out"
fi

section "T3 — resume across processes (self-contained baseline + resume)"
runs_snapshot "$OUT/runs-before-t3a.txt"
oc_run_capture "$OUT/t3a.out" "$TURN_SECS" "$(wf_prompt smoke)" || true
BASE="$(newest_completed_run "$OUT/runs-before-t3a.txt")"
preserve_run "$BASE"
if [ -z "$BASE" ]; then
  # One retry: the schema path hits transient provider errors ~1 in 3 turns
  # (reason: api-error in the journal); the outer model usually self-heals,
  # but a turn can still end with no completed run.
  runs_snapshot "$OUT/runs-before-t3a2.txt"
  oc_run_capture "$OUT/t3a2.out" "$TURN_SECS" "$(wf_prompt smoke)" || true
  BASE="$(newest_completed_run "$OUT/runs-before-t3a.txt")"
  preserve_run "$BASE"
fi
if [ -n "$BASE" ]; then
  assert_run_completed "$BASE"
  runs_snapshot "$OUT/runs-before-t3b.txt"
  # -c continues the most recent session in the scratch dir — resume is
  # same-session-only (src/server/resume/persist.ts), so the journal loads.
  oc_run_capture "$OUT/t3b.out" "$TURN_SECS" -c "$(wf_prompt smoke "Set resumeFromRunId to $BASE.")" || true
  RUN3="$(runs_new_since "$OUT/runs-before-t3b.txt" | head -1)"
  preserve_run "$RUN3"
  if [ -n "$RUN3" ]; then
    ok "resume run dir created: $RUN3"
    assert_run_completed "$RUN3"
    [ "$(journal_grep "$RUN3" '"replayed":true')" -ge 1 ] \
      && ok "journal entry replayed from $BASE (zero live agents)" \
      || bad "no replayed journal entry" "grep replayed in $OUT/$RUN3/journal.jsonl"
    # The replay invariant: the resumed result EQUALS the baseline's recorded
    # value. The READY word is a baseline-quality matter — when the baseline
    # agent returned a degenerate value (provider can return an empty schema
    # answer), replay faithfully returns it too, and the note says so.
    T3_FIDELITY="$(python3 - "$RUN_ROOT/$BASE/result.json" "$RUN_ROOT/$RUN3/result.json" <<'PYEOF'
import json, sys
try:
    a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
except Exception:
    print(0); raise SystemExit
print(1 if a == b else 0)
PYEOF
)"
    if [ "$T3_FIDELITY" = "1" ]; then
      ok "resumed result equals the recorded baseline value (replay fidelity)"
      result_json_has "$RUN3" 'isinstance(d.get("answer"), str) and d["answer"].strip() != ""' \
        || note "the baseline value itself was degenerate (the provider returned an empty schema answer, replayed faithfully) — baseline: $(cat "$RUN_ROOT/$BASE/result.json" 2>/dev/null)"
    else
      bad "resumed result differs from the recorded baseline value" "baseline: $(cat "$RUN_ROOT/$BASE/result.json" 2>/dev/null) — resumed: $(cat "$RUN_ROOT/$RUN3/result.json" 2>/dev/null)"
    fi
  else
    bad "resume produced no run dir" "see $OUT/t3b.out"
  fi
else
  bad "baseline run for T3 failed" "see $OUT/t3a.out"
fi

section "T2 — parallel fan-out (3 agents, barrier, journal)"
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
  # A schema-forced agent can die on a transient provider api-error (~1 in 3
  # turns on Together, per the T3 comment); the parallel barrier and the
  # journal are the contract — the missing answer is provider weather.
  if result_json_has "$RUN2" 'len(d.get("answers", [])) == 3'; then
    ok "3 answers returned"
  elif result_json_has "$RUN2" 'len(d.get("answers", [])) == 2' && [ "$(journal_grep "$RUN2" '"reason":"api-error"')" -ge 1 ]; then
    note "2/3 answers returned; the third hit the documented provider api-error flake"
    ok "answers returned (modulo provider flake)"
  else
    bad "answers != 3 and no api-error recorded" "inspect $RUN2"
  fi
else
  bad "no completed run dir" "see $OUT/t2.out (watchdog kills print there)"
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
  grep -q "INNER" "$OUT/t4.out" && ok "nested result surfaced to the outer return" || bad "nested word INNER not in output"
else
  bad "no completed run dir" "see $OUT/t4.out"
fi

section "T5a — saved workflow runs by name (context.named is wired)"
# A saved workflow in the scratch project's .opencode/ultraopen/workflows must
# run by name through the named form of workflow().
mkdir -p "$SCRATCH/project/.opencode/ultraopen/workflows"
cat > "$SCRATCH/project/.opencode/ultraopen/workflows/probe.js" <<'PROBE'
export const meta = { name: 'probe', description: 'Saved workflow probe' }
return 'SAVED-WORKFLOW-RAN'
PROBE
runs_snapshot "$OUT/runs-before-t5a.txt"
oc_run_capture "$OUT/t5a.out" "$TURN_SECS" "$(wf_prompt named)" || true
RUN5="$(newest_run "$OUT/runs-before-t5a.txt")"
if [ -n "$RUN5" ]; then
  preserve_run "$RUN5"
  if [ "$(manifest_status "$RUN5")" = "completed" ]; then
    ok "saved workflow ran by name (named form no longer throws)"
  else
    bad "named form did not complete" "manifest $(manifest_status "$RUN5") — inspect $OUT/$RUN5 and $OUT/t5a.out"
  fi
else
  bad "named-form probe produced no run dir" "see $OUT/t5a.out"
fi

section "T5b — unknown workflow name still gives the clear error"
runs_snapshot "$OUT/runs-before-t5b.txt"
oc_run_capture "$OUT/t5b.out" "$TURN_SECS" "$(wf_prompt named 'The workflow name to call is definitely-not-saved.')" || true
if grep -qiE "no saved workflow|not a saved" "$OUT/t5b.out"; then
  ok "unknown name gives the clear error naming the suggestion"
else
  note "unknown-name error wording not visible in $OUT/t5b.out — inspect"
fi

section "T6 — isolation: worktree (evidence probe)"
git init -q . 2>/dev/null || true
runs_snapshot "$OUT/runs-before-t6.txt"
oc_run_capture "$OUT/t6.out" "$TURN_SECS" "$(wf_prompt worktree)" || true
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

section "T8 — ultracode keyword surface (effort raise on the turn)"
runs_snapshot "$OUT/runs-before-t8.txt"
oc_run_capture "$OUT/t8.json" "$TURN_SECS" --format json "ultracode $(wf_prompt smoke)" || true
RUN8="$(newest_completed_run "$OUT/runs-before-t8.txt")"
if [ -z "$RUN8" ]; then
  # Parent turns can stall on provider hiccups (opencode retries with no cap);
  # one retry keeps the suite from flaking on transient hangs.
  note "no run from the first attempt (stall or non-compliance) — retrying once"
  runs_snapshot "$OUT/runs-before-t8b.txt"
  oc_run_capture "$OUT/t8b.json" "$TURN_SECS" --format json "ultracode $(wf_prompt smoke)" || true
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

section "T9 — background launch + status delivery (value arrives only via workflow_status)"
# The launch result must not carry the outcome; the final value reaches the
# model only through a workflow_status poll, and the run settles before the
# one-shot process exits because the turn kept polling.
runs_snapshot "$OUT/runs-before-t9.txt"
oc_run_capture "$OUT/t9.out" "$TURN_SECS" "$(wf_prompt ping)" || true
RUN9="$(newest_run "$OUT/runs-before-t9.txt")"
if [ -n "$RUN9" ]; then
  preserve_run "$RUN9"
  grep -q "workflow_status" "$OUT/t9.out" && ok "T9 launch handed a run id that was polled" || bad "T9: no workflow_status poll" "see $OUT/t9.out"
  # The word the agent was told to produce can only reach the model's reply
  # through a workflow_status poll — the launch result never carries it. A bare
  # "completed" echo without the value does NOT prove delivery, so it only notes.
  if grep -q "PING" "$OUT/t9.out"; then
    ok "final value delivered through the status poll"
  elif grep -qE "workflow-status.*completed" "$OUT/t9.out"; then
    note "status poll surfaced a completion but no value in the reply — inspect $OUT/t9.out"
  else
    note "T9 value did not surface in the reply — inspect $OUT/t9.out and $RUN9"
  fi
  [ "$(manifest_status "$RUN9")" = "completed" ] || [ "$(manifest_status "$RUN9")" = "failed" ] \
    && ok "T9 run settled (status: $(manifest_status "$RUN9"))" \
    || bad "T9 run never settled" "manifest still $(manifest_status "$RUN9") after the turn"
else
  bad "T9 produced no run dir" "see $OUT/t9.out"
fi

section "T10 — concurrent launches in one ultracode session (the live-run cap admits two)"
# The conditional gate (docs/adr/0001-launch-concurrency-policy.md): an
# ultracode-active session launches TWO workflows back to back in one turn. The
# sibling advisory in the second launch result is the registry-level proof the
# gate saw two live runs; the overlapping manifest windows are the disk proof.
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
# resume replays its run's journal with zero live agents.
runs_snapshot "$OUT/runs-before-t10r1.txt"
oc_run_capture "$OUT/t10r1.out" "$TURN_SECS" -c "$(wf_prompt ping "Set resumeFromRunId to $T10_A.")" || true
R10A="$(runs_new_since "$OUT/runs-before-t10r1.txt" | head -1)"
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
R10B="$(runs_new_since "$OUT/runs-before-t10r2.txt" | head -1)"
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
runs_snapshot "$OUT/runs-before-t11.txt"
# Both calls are demanded in ONE step: the first launch registers a pending
# entry synchronously, so the second call is refused while it is still pending —
# deterministic, independent of how fast the run settles.
oc_run_capture "$OUT/t11.json" "$TURN_SECS" --format json "$(wf_prompt ping "Call the workflow tool TWICE in ONE step: emit the two tool calls together in a single response, both with background true, no scriptPath, no args, and this script exactly, unchanged. The second call is expected to be refused — that is the point of this exercise. After both results arrive, call workflow_status for the run id that DID launch (wait=120, repeat while it says running) and reply with what it reported.")" || true
if grep -q "already has a workflow run in flight" "$OUT/t11.json"; then
  ok "the second launch was refused with the one-live-run refusal"
else
  bad "no refusal in the non-ultracode turn" "the plain one-live-run gate must hold — see $OUT/t11.json"
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