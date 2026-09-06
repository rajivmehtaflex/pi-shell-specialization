#!/usr/bin/env bash
# P2.5 -- Base/student evaluation.
#
# EXTERNAL-prerequisite phase: comparing the base student with SFT v0.1 on
# the hidden holdout needs the trained checkpoint and an evaluation host.
# This script never runs a model itself.
# Prerequisites:
#   * data/splits/holdout.jsonl -- the hidden holdout split (P2.2 output);
#   * EVAL_COMMAND -- shell command that evaluates base + student over the
#     holdout with the same verifier (typically launched remotely via the
#     P2.5 command in state/phase-commands.json, gpu "1x<model>") and writes
#     its summary JSON.
# Optional:
#   * EVAL_SUMMARY_PATH (default artifacts/eval/summary.json) -- category
#     pass rates, confidence intervals, and the improvement-gate verdict.
# Do not start P2.6 GRPO if the improvement gate fails.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.5"

require_file "$PROJECT_ROOT/data/splits/holdout.jsonl" "the hidden holdout split (run scripts/phases/p2-2-audit-split.sh first)" > /dev/null
EVAL_COMMAND="$(require_env EVAL_COMMAND "a shell command that evaluates base vs student over data/splits/holdout.jsonl")"

eval_summary="${EVAL_SUMMARY_PATH:-$PROJECT_ROOT/artifacts/eval/summary.json}"
mkdir -p "$(dirname "$eval_summary")" "$PROJECT_ROOT/state/runs/P2.5"
if ! bash -c "$EVAL_COMMAND" > "$PROJECT_ROOT/state/runs/P2.5/eval.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.5/eval.log"
  phase_fail "EVAL_COMMAND failed; see state/runs/P2.5/eval.log"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.5/eval.log"

if [ -f "$eval_summary" ]; then
  manifest_add_artifact "$eval_summary"
fi

manifest_emit_success
