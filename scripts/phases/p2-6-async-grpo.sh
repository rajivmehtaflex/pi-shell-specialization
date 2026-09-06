#!/usr/bin/env bash
# P2.6 -- GRPO sharpening (loop-owning AsyncGRPO).
#
# HARD two-GPU phase. The gate below runs FIRST and refuses every
# single-GPU configuration no matter what else is configured: GRPO_GPUS must
# list at least two distinct GPU ids and PI_GRPO_REQUIRE_2_GPU must be "1"
# or unset. There is no override and no single-GPU fallback.
# Topology (article-style): one GPU serves the current student policy through
# vLLM; the other runs the TRL AsyncGRPO trainer; the Pi loop-owning harness
# talks to the policy through the transparent proxy; reward comes only from
# hidden shell verification; the teacher is unavailable during rollouts.
# Prerequisites:
#   * GRPO_GPUS -- at least two distinct GPU ids (e.g. "0,1");
#   * GRPO_COMMAND -- shell command that launches the AsyncGRPO run (smoke
#     first: small prompt count, small step count, nonzero reward_std);
#   * data/splits/eval.jsonl -- reward task split (P2.2 output).
# Optional:
#   * GRPO_REWARD_REPORT (default artifacts/grpo/reward-report.json).
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.6"

# Gate order matters: the two-GPU check happens before anything else.
require_two_gpus
GRPO_COMMAND="$(require_env GRPO_COMMAND "the AsyncGRPO trainer command (e.g. a TRL AsyncGRPOTrainer launcher; one GPU serves the policy vLLM, the other trains)")"
require_file "$PROJECT_ROOT/data/splits/eval.jsonl" "the reward task split (run scripts/phases/p2-2-audit-split.sh first)" > /dev/null

mkdir -p "$PROJECT_ROOT/artifacts/grpo" "$PROJECT_ROOT/state/runs/P2.6"
if ! bash -c "$GRPO_COMMAND" > "$PROJECT_ROOT/state/runs/P2.6/grpo.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.6/grpo.log"
  phase_fail "GRPO_COMMAND failed; see state/runs/P2.6/grpo.log"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.6/grpo.log"

reward_report="${GRPO_REWARD_REPORT:-$PROJECT_ROOT/artifacts/grpo/reward-report.json}"
if [ -f "$reward_report" ]; then
  manifest_add_artifact "$reward_report"
fi

manifest_emit_success
