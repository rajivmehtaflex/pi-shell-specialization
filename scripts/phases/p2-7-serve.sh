#!/usr/bin/env bash
# P2.7 -- Serve at 64K (final serving smoke test).
#
# EXTERNAL-prerequisite phase: serving (vLLM or llama.cpp) needs the release
# checkpoint and a GPU host. This script never starts long-lived servers in
# the background: SERVE_COMMAND must start the server, run the
# OpenAI-compatible health/model/tool-call smoke checks against the target
# context configuration, and exit nonzero on failure (a server intended to
# keep running should be launched by SERVE_COMMAND itself, e.g. with nohup,
# after the smoke checks pass).
# Prerequisites:
#   * a successful P2.6b or P2.4 release manifest;
#   * SERVE_COMMAND -- shell command performing the serving smoke test.
# Optional:
#   * SERVE_CONTEXT_LENGTH (default 65536) -- exported for SERVE_COMMAND;
#   * SERVE_HEALTH_PATH (default artifacts/serve/health.json) -- smoke
#     result JSON picked up as an artifact when present.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.7"

release_manifest=""
for candidate in "$PROJECT_ROOT/state/runs/P2.6b/result.json" "$PROJECT_ROOT/state/runs/P2.4/result.json"; do
  if [ -f "$candidate" ] && grep -q '"status": "success"' "$candidate"; then
    release_manifest="$candidate"
    break
  fi
done
if [ -z "$release_manifest" ]; then
  phase_fail "prerequisite missing: no successful release manifest from P2.6b or P2.4 (run scripts/phases/p2-6b-merge-upload.sh or scripts/phases/p2-4-merge-upload.sh first)"
fi
SERVE_COMMAND="$(require_env SERVE_COMMAND "a shell command that serves the pinned release (vLLM/llama.cpp), smoke-tests the OpenAI-compatible endpoint at the target context length, and exits nonzero on failure")"

export SERVE_CONTEXT_LENGTH="${SERVE_CONTEXT_LENGTH:-65536}"
serve_health="${SERVE_HEALTH_PATH:-$PROJECT_ROOT/artifacts/serve/health.json}"
mkdir -p "$(dirname "$serve_health")" "$PROJECT_ROOT/state/runs/P2.7"
if ! bash -c "$SERVE_COMMAND" > "$PROJECT_ROOT/state/runs/P2.7/serve.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.7/serve.log"
  phase_fail "SERVE_COMMAND failed; see state/runs/P2.7/serve.log"
fi
manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.7/serve.log"

if [ -f "$serve_health" ]; then
  manifest_add_artifact "$serve_health"
fi

manifest_emit_success
