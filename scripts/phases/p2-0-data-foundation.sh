#!/usr/bin/env bash
# P2.0 -- Shell data foundation.
#
# Local-verifiable part (no GPU, no network, no push):
#   1. benchmark unit-test selection passes (node --test over the fixture,
#      parser, scoring, and safety suites);
#   2. the package CLI validates the 60 benchmark cases;
#   3. the machine-readable task pool (one {"task": ...} object per line) is
#      written to data/tasks/benchmark-tasks.jsonl for P2.1/P2.2.
# Prerequisite: node >= 22 on PATH (dist build preferred; falls back to Node
# type stripping). P2.0 declares computeMode "none": no GPU is required.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.0"

require_command node "node >= 22 must be installed" > /dev/null
resolve_package_cli

mkdir -p "$PROJECT_ROOT/artifacts/p2-0"
if ! ( cd "$REPO_ROOT" && node --test src/fixtures.test.ts src/parser.test.ts src/scoring.test.ts src/safety.test.ts ) \
    > "$PROJECT_ROOT/artifacts/p2-0/benchmark-tests.log" 2>&1; then
  manifest_add_artifact "$PROJECT_ROOT/artifacts/p2-0/benchmark-tests.log"
  phase_fail "benchmark test selection failed; see artifacts/p2-0/benchmark-tests.log"
fi
manifest_add_artifact "$PROJECT_ROOT/artifacts/p2-0/benchmark-tests.log"

if ! run_package_cli "$PROJECT_ROOT/artifacts/p2-0/validation.log" validate; then
  manifest_add_artifact "$PROJECT_ROOT/artifacts/p2-0/validation.log"
  phase_fail "package validation failed (npm run validate); see artifacts/p2-0/validation.log"
fi
manifest_add_artifact "$PROJECT_ROOT/artifacts/p2-0/validation.log"

build_tasks_jsonl "$PROJECT_ROOT/data/tasks/benchmark-tasks.jsonl" > /dev/null
manifest_add_artifact "$PROJECT_ROOT/data/tasks/benchmark-tasks.jsonl"

manifest_emit_success
