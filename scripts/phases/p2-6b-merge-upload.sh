#!/usr/bin/env bash
# P2.6b -- Merge and upload GRPO v0.2.
#
# EXTERNAL-prerequisite phase: merge/export v0.2 and push the pinned release.
# This script never pushes by itself; it runs the operator-provided command.
# Prerequisites:
#   * a successful P2.6 result manifest (state/runs/P2.6/result.json) --
#     GRPO must finish with nonzero reward variance, no reward collapse, and
#     an improvement over the SFT checkpoint;
#   * GRPO_MERGE_UPLOAD_COMMAND (or MERGE_UPLOAD_COMMAND) -- shell command
#     that merges the GRPO policy into v0.2 and pushes it to the HF remote,
#     preserving SFT v0.1 as the fallback release.
# Optional:
#   * HF_REVISION -- pinned HF revision written to
#     artifacts/grpo/hf-revision.txt after a successful push.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.6b"

p26_manifest="$PROJECT_ROOT/state/runs/P2.6/result.json"
require_file "$p26_manifest" "the P2.6 result manifest (run scripts/phases/p2-6-async-grpo.sh first)" > /dev/null
if ! grep -q '"status": "success"' "$p26_manifest"; then
  phase_fail "P2.6 did not succeed; refusing to publish a v0.2 release from a failed GRPO run (state/runs/P2.6/result.json)"
fi
merge_command="${GRPO_MERGE_UPLOAD_COMMAND:-${MERGE_UPLOAD_COMMAND:-}}"
if [ -z "$merge_command" ]; then
  phase_fail "external prerequisite missing: set GRPO_MERGE_UPLOAD_COMMAND (or MERGE_UPLOAD_COMMAND) to the command that merges the GRPO policy into v0.2 and pushes it to the HF remote; this script itself never pushes"
fi

mkdir -p "$PROJECT_ROOT/artifacts/grpo" "$PROJECT_ROOT/state/runs/P2.6b"
if ! bash -c "$merge_command" > "$PROJECT_ROOT/state/runs/P2.6b/merge-upload.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.6b/merge-upload.log"
  phase_fail "GRPO_MERGE_UPLOAD_COMMAND failed; see state/runs/P2.6b/merge-upload.log"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.6b/merge-upload.log"

if [ -n "${HF_REVISION:-}" ]; then
  printf '%s\n' "$HF_REVISION" > "$PROJECT_ROOT/artifacts/grpo/hf-revision.txt"
fi
if [ -f "$PROJECT_ROOT/artifacts/grpo/hf-revision.txt" ]; then
  manifest_add_artifact "$PROJECT_ROOT/artifacts/grpo/hf-revision.txt"
fi

manifest_emit_success
