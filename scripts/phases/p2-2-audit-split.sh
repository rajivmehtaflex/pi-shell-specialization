#!/usr/bin/env bash
# P2.2 -- Dataset audit and split (teacher verification + audit + split + gate).
#
# Pipeline (all local, CPU-only; no GPU, no network, no push):
#   1. teacher rows are verified in the isolated evaluator with
#      workers/verify.py -- unless the rows are already verified envelopes
#      (their first row carries "verification" and "execution", e.g. rows
#      produced by the remote verifier or scripts/phases/pi-rollout.sh);
#   2. audit gate: workers/teacher_audit.py dedupes and rejects leakage;
#      its exit code 2 (rows rejected) is recorded in the report but the
#      numeric dataset gate below remains the pass/fail authority;
#   3. production split: workers/split.py (eval=250, holdout=250, train=rest,
#      >= 2300 accepted rows after dedup);
#   4. numeric dataset gate, mirroring
#      src/orchestrator/data-phase.ts evaluateDatasetGate:
#        live:    train >= 1800, eval == 250, holdout == 250, balanceDelta <= 0.1
#        dry-run: at least one row per split (PI_DATASET_GATE=dry-run)
#      written to artifacts/dataset-gate.json.
# Prerequisites: python3; teacher rows at TEACHER_ROWS, state/teacher_raw.jsonl
# (P2.1 default), or data/teacher/teacher-raw.jsonl.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.2"

require_command python3 "python3 must be installed (the data workers are python)" > /dev/null

TEACHER_SOURCE=""
if [ -n "${TEACHER_ROWS:-}" ]; then
  TEACHER_ROWS="$(require_file "$TEACHER_ROWS" "the teacher rows file (TEACHER_ROWS)")"
  TEACHER_SOURCE="$TEACHER_ROWS"
elif [ -f "$PROJECT_ROOT/state/teacher_raw.jsonl" ]; then
  TEACHER_SOURCE="$PROJECT_ROOT/state/teacher_raw.jsonl"
elif [ -f "$PROJECT_ROOT/data/teacher/teacher-raw.jsonl" ]; then
  TEACHER_SOURCE="$PROJECT_ROOT/data/teacher/teacher-raw.jsonl"
else
  phase_fail "prerequisite missing: no teacher rows to audit. Set TEACHER_ROWS=<path> or provide state/teacher_raw.jsonl (run scripts/phases/p2-1-teacher-inference.sh first)."
fi

mkdir -p "$PROJECT_ROOT/data/teacher" "$PROJECT_ROOT/data/splits" "$PROJECT_ROOT/artifacts/audit" "$PROJECT_ROOT/state/runs/P2.2"

# Rows that already carry verification+execution are accepted as-is; raw rows
# go through workers/verify.py (which executes each response in isolation).
if python3 - "$TEACHER_SOURCE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        if line.strip():
            row = json.loads(line)
            sys.exit(0 if isinstance(row, dict) and "verification" in row and "execution" in row else 1)
sys.exit(1)
PY
then
  cp "$TEACHER_SOURCE" "$PROJECT_ROOT/data/teacher/verified.jsonl"
else
  if ! run_worker verify.py --input "$TEACHER_SOURCE" --out "$PROJECT_ROOT/data/teacher/verified.jsonl" \
      2> "$PROJECT_ROOT/state/runs/P2.2/verify.stderr"; then
    manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.2/verify.stderr"
    phase_fail "workers/verify.py failed; see state/runs/P2.2/verify.stderr"
  fi
fi
manifest_add_artifact "$PROJECT_ROOT/data/teacher/verified.jsonl"

audit_status=0
run_worker teacher_audit.py \
  --in "$PROJECT_ROOT/data/teacher/verified.jsonl" \
  --out "$PROJECT_ROOT/data/teacher/accepted.jsonl" \
  --report "$PROJECT_ROOT/artifacts/audit/report.json" || audit_status=$?
case "$audit_status" in
  0|2) ;;
  *)
    if [ -f "$PROJECT_ROOT/artifacts/audit/report.json" ]; then
      manifest_add_artifact "$PROJECT_ROOT/artifacts/audit/report.json"
    fi
    phase_fail "workers/teacher_audit.py failed unexpectedly (exit $audit_status); see artifacts/audit/report.json"
    ;;
esac
manifest_add_artifact "$PROJECT_ROOT/data/teacher/accepted.jsonl"
manifest_add_artifact "$PROJECT_ROOT/artifacts/audit/report.json"

if ! run_worker split.py \
  --in "$PROJECT_ROOT/data/teacher/accepted.jsonl" \
  --train "$PROJECT_ROOT/data/splits/train.jsonl" \
  --eval "$PROJECT_ROOT/data/splits/eval.jsonl" \
  --holdout "$PROJECT_ROOT/data/splits/holdout.jsonl" \
  --seed "${SPLIT_SEED:-42}" \
  > "$PROJECT_ROOT/state/runs/P2.2/split-summary.json" \
  2> "$PROJECT_ROOT/state/runs/P2.2/split.stderr"; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.2/split.stderr"
  phase_fail "workers/split.py failed (the production split needs at least 2300 accepted rows); see state/runs/P2.2/split.stderr"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.2/split-summary.json"
manifest_add_artifact "$PROJECT_ROOT/data/splits/train.jsonl"
manifest_add_artifact "$PROJECT_ROOT/data/splits/eval.jsonl"
manifest_add_artifact "$PROJECT_ROOT/data/splits/holdout.jsonl"

# Numeric dataset gate (same thresholds as evaluateDatasetGate in
# src/orchestrator/data-phase.ts). Writes artifacts/dataset-gate.json.
gate_status=0
PROJECT_ROOT="$PROJECT_ROOT" python3 - <<'PY' || gate_status=$?
import json
import os
import sys

root = os.environ["PROJECT_ROOT"]
with open(os.path.join(root, "state", "runs", "P2.2", "split-summary.json"), encoding="utf-8") as handle:
    summary = json.load(handle)

def count(name):
    with open(os.path.join(root, "data", "splits", name), encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())

counts = {"train": count("train.jsonl"), "eval": count("eval.jsonl"), "holdout": count("holdout.jsonl")}
balance_delta = float(summary.get("balanceDelta", 1.0))
mode = os.environ.get("PI_DATASET_GATE", "live")
failures = []
if mode == "dry-run":
    if any(value < 1 for value in counts.values()):
        failures.append("dry-run needs at least one row in each split")
else:
    if counts["train"] < 1800:
        failures.append("train split must contain at least 1800 rows")
    if counts["eval"] != 250:
        failures.append("eval split must contain exactly 250 rows")
    if counts["holdout"] != 250:
        failures.append("holdout split must contain exactly 250 rows")
    if balance_delta > 0.1:
        failures.append("category balance exceeds ±10%")

gate = {
    "phase": "P2.2",
    "mode": mode,
    "train": counts["train"],
    "eval": counts["eval"],
    "holdout": counts["holdout"],
    "balanceDelta": balance_delta,
    "passed": not failures,
    "failures": failures,
    "productionReady": mode == "live" and not failures,
}
gate_path = os.path.join(root, "artifacts", "dataset-gate.json")
with open(gate_path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(gate, indent=2, sort_keys=True) + "\n")
print(json.dumps(gate, sort_keys=True))
sys.exit(0 if not failures else 1)
PY
manifest_add_artifact "$PROJECT_ROOT/artifacts/dataset-gate.json"
if [ "$gate_status" -ne 0 ]; then
  phase_fail "dataset gate failed (mode ${PI_DATASET_GATE:-live}); see artifacts/dataset-gate.json -- do not continue with undersized or unbalanced data"
fi

manifest_emit_success
