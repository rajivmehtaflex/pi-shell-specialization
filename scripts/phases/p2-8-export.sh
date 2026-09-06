#!/usr/bin/env bash
# P2.8 -- Pi provider and final export.
#
# Local-verifiable part (no GPU, no push):
#   1. the external-evaluator bundle is exported to artifacts/export/bundle;
#   2. a Pi provider config pointing at the pinned student endpoint is
#      written to artifacts/export/pi-provider.json;
#   3. the final deployment manifest is written to
#      artifacts/export/deployment-manifest.json.
# Prerequisite: node >= 22 (dist build preferred; falls back to Node type
# stripping). Optional: PI_STUDENT_ENDPOINT / PI_STUDENT_MODEL (pinned
# release endpoint), HF_REVISION, SERVE_CONTEXT_LENGTH.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.8"

require_command node "node >= 22 must be installed" > /dev/null
resolve_package_cli

mkdir -p "$PROJECT_ROOT/artifacts/export" "$PROJECT_ROOT/state/runs/P2.8"
if ! run_package_cli "$PROJECT_ROOT/state/runs/P2.8/export-bundle.log" export-bundle --out "$PROJECT_ROOT/artifacts/export/bundle"; then
  manifest_add_artifact "$PROJECT_ROOT/state/runs/P2.8/export-bundle.log"
  phase_fail "evaluator bundle export failed; see state/runs/P2.8/export-bundle.log"
fi
manifest_add_artifact "$PROJECT_ROOT/artifacts/export/bundle/questions/shell-questions-60.json"

endpoint="${PI_STUDENT_ENDPOINT:-REPLACE_WITH_PINNED_STUDENT_ENDPOINT}"
model="${PI_STUDENT_MODEL:-pi-shell-specialized-v0.2}"
context="${SERVE_CONTEXT_LENGTH:-65536}"
cat > "$PROJECT_ROOT/artifacts/export/pi-provider.json" <<EOF
{
  "provider": "openai-compatible",
  "baseUrl": "$endpoint",
  "model": "$model",
  "contextLength": $context,
  "extension": "./src/index.ts",
  "notes": "Point Pi at the pinned student release endpoint from the P2.6b/P2.4 revision before real traffic; never run model-generated shell code on the analysis machine."
}
EOF
manifest_add_artifact "$PROJECT_ROOT/artifacts/export/pi-provider.json"

revision="${HF_REVISION:-unknown}"
PROJECT_ROOT="$PROJECT_ROOT" P2_REVISION="$revision" python3 - <<'PY'
import datetime
import json
import os

root = os.environ["PROJECT_ROOT"]
manifest = {
    "phase": "P2.8",
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "studentRevision": os.environ.get("P2_REVISION", "unknown"),
    "components": {
        "evaluatorBundle": "artifacts/export/bundle",
        "piProviderConfig": "artifacts/export/pi-provider.json",
    },
    "notes": "Final deployment manifest; artifacts live under COMMITTABLE_ROOTS for checkpoint sync.",
}
path = os.path.join(root, "artifacts", "export", "deployment-manifest.json")
with open(path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
PY
manifest_add_artifact "$PROJECT_ROOT/artifacts/export/deployment-manifest.json"

manifest_emit_success
