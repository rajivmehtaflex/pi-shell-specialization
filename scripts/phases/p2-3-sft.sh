#!/usr/bin/env bash
# P2.3 -- QLoRA/SFT.
#
# EXTERNAL-prerequisite phase: real training needs a GPU host. This script
# never downloads models and never pushes.
# Prerequisites:
#   * data/splits/train.jsonl -- the verified train split (P2.2 output);
#   * TRAIN_SFT_COMMAND -- a shell command that runs QLoRA/SFT on the current
#     host (typically launched remotely via the P2.3 command in
#     state/phase-commands.json with gpu "1x<model>").
# Optional:
#   * SFT_OUTPUT_DIR (default artifacts/sft) -- trainer output directory;
#     adapter_config.json is picked up as an artifact when present.
# 1-GPU smoke path: point TRAIN_SFT_COMMAND at a tiny run first, e.g.
#   TRAIN_SFT_COMMAND='python3 -m trainers.sft --dataset data/splits/train.jsonl \
#     --max-steps 5 --output-dir artifacts/sft'
# and only then schedule the full 3-epoch run.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.3"

require_file "$PROJECT_ROOT/data/splits/train.jsonl" "the verified train split (run scripts/phases/p2-2-audit-split.sh first)" > /dev/null
TRAIN_SFT_COMMAND="$(require_env TRAIN_SFT_COMMAND "a shell command that runs QLoRA/SFT on a GPU host; do a short 1-GPU smoke run before the full job")"

mkdir -p "${SFT_OUTPUT_DIR:-$PROJECT_ROOT/artifacts/sft}" "$PROJECT_ROOT/state/runs/P2.3"
if ! bash -c "$TRAIN_SFT_COMMAND" > "$PROJECT_ROOT/state/runs/P2.3/sft.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.3/sft.log"
  phase_fail "TRAIN_SFT_COMMAND failed; see state/runs/P2.3/sft.log"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.3/sft.log"

sft_output_dir="${SFT_OUTPUT_DIR:-$PROJECT_ROOT/artifacts/sft}"
if [ -f "$sft_output_dir/adapter_config.json" ]; then
  manifest_add_artifact "$sft_output_dir/adapter_config.json"
fi

manifest_emit_success
