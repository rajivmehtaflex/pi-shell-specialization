#!/usr/bin/env bash
# P0 -- Baseline weakness profile.
#
# Local-verifiable part (no GPU, no network, no push):
#   1. node + python3 toolchain is present;
#   2. the package CLI validates all 60 benchmark cases (npm run validate);
#   3. sanitized public questions are exported to artifacts/p0/ (the export
#      never contains fixtures, verifiers, or expected exit codes).
# External prerequisite (optional here): the real base-model evaluation that
# produces the weakness profile needs a model endpoint/GPU host. Set
# EVAL_BASELINE_COMMAND to run it as part of this phase (typically on the SSH
# host via the P0 command in state/phase-commands.json); without it, the
# phase completes with the local baseline artifacts only.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P0"

require_command node "node >= 22 must be installed" > /dev/null
require_command python3 "python3 must be installed (the data workers are python)" > /dev/null
resolve_package_cli

mkdir -p "$PROJECT_ROOT/artifacts/p0"
if ! run_package_cli "$PROJECT_ROOT/artifacts/p0/validation.log" validate; then
  manifest_add_artifact "$PROJECT_ROOT/artifacts/p0/validation.log"
  phase_fail "package validation failed (npm run validate); see artifacts/p0/validation.log"
fi
manifest_add_artifact "$PROJECT_ROOT/artifacts/p0/validation.log"

if ! run_package_cli "$PROJECT_ROOT/artifacts/p0/questions.log" questions --public --out "$PROJECT_ROOT/artifacts/p0/public-questions.json"; then
  manifest_add_artifact "$PROJECT_ROOT/artifacts/p0/questions.log"
  phase_fail "sanitized public-question export failed; see artifacts/p0/questions.log"
fi
manifest_add_artifact "$PROJECT_ROOT/artifacts/p0/public-questions.json"

if [ -n "${EVAL_BASELINE_COMMAND:-}" ]; then
  mkdir -p "$PROJECT_ROOT/artifacts/p0"
  if ! bash -c "$EVAL_BASELINE_COMMAND" > "$PROJECT_ROOT/artifacts/p0/baseline-eval.log" 2>&1; then
    manifest_add_artifact "$PROJECT_ROOT/artifacts/p0/baseline-eval.log"
    phase_fail "EVAL_BASELINE_COMMAND failed; see artifacts/p0/baseline-eval.log"
  fi
  manifest_add_artifact "$PROJECT_ROOT/artifacts/p0/baseline-eval.log"
fi

manifest_emit_success
