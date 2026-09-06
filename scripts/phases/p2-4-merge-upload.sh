#!/usr/bin/env bash
# P2.4 -- Merge and upload SFT v0.1.
#
# EXTERNAL-prerequisite phase: merging the adapter into the base model and
# pushing the release needs the base checkpoint plus HF credentials on the
# execution host. This script never pushes by itself; it runs the
# operator-provided MERGE_UPLOAD_COMMAND and records the evidence.
# Prerequisites:
#   * a successful P2.3 result manifest (state/runs/P2.3/result.json);
#   * MERGE_UPLOAD_COMMAND -- shell command that merges the verified SFT
#     adapter into the student release artifact, validates tokenizer/config
#     files, and pushes only allowlisted model metadata + Git-LFS artifacts
#     to the HF remote (never overwriting an existing release revision).
# Optional:
#   * HF_REVISION -- the pinned HF revision written to
#     artifacts/sft/hf-revision.txt after a successful push.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.4"

p23_manifest="$PROJECT_ROOT/state/runs/P2.3/result.json"
require_file "$p23_manifest" "the P2.3 result manifest (run scripts/phases/p2-3-sft.sh first)" > /dev/null
if ! grep -q '"status": "success"' "$p23_manifest"; then
  phase_fail "P2.3 did not succeed; refusing to merge from a failed SFT run (state/runs/P2.3/result.json)"
fi
MERGE_UPLOAD_COMMAND="$(require_env MERGE_UPLOAD_COMMAND "a shell command that merges the SFT adapter and pushes the v0.1 release to the HF remote; this script itself never pushes")"

mkdir -p "$PROJECT_ROOT/artifacts/sft" "$PROJECT_ROOT/state/runs/P2.4"
if ! bash -c "$MERGE_UPLOAD_COMMAND" > "$PROJECT_ROOT/state/runs/P2.4/merge-upload.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.4/merge-upload.log"
  phase_fail "MERGE_UPLOAD_COMMAND failed; see state/runs/P2.4/merge-upload.log"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.4/merge-upload.log"

if [ -n "${HF_REVISION:-}" ]; then
  printf '%s\n' "$HF_REVISION" > "$PROJECT_ROOT/artifacts/sft/hf-revision.txt"
fi
if [ -f "$PROJECT_ROOT/artifacts/sft/hf-revision.txt" ]; then
  manifest_add_artifact "$PROJECT_ROOT/artifacts/sft/hf-revision.txt"
fi

manifest_emit_success
