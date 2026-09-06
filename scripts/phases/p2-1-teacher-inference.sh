#!/usr/bin/env bash
# P2.1 -- Teacher inference.
#
# Local-verifiable part (no GPU, no network, no push):
#   * the weakness/task pool is synthesized with workers/synth_gen.py into
#     data/teacher/generated-tasks.jsonl.
# External prerequisite (exactly one of):
#   * TEACHER_ROWS=<path> pointing at teacher envelope-rows JSONL that an
#     external teacher already produced (typically the configured P2.1 phase
#     command from state/phase-commands.json running on the teacher host,
#     or scripts/phases/pi-rollout.sh against a configured PI_* endpoint);
#   * an existing state/teacher_raw.jsonl from a previous run;
#   * data/teacher/teacher-raw.jsonl from a previous run of this script.
# The script itself never calls a model endpoint. Teacher rows are copied to
# data/teacher/teacher-raw.jsonl for P2.2.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

manifest_begin "P2.1"

require_command python3 "python3 must be installed (workers/synth_gen.py)" > /dev/null

TASKS_FILE="${TASKS_FILE:-$PROJECT_ROOT/data/tasks/benchmark-tasks.jsonl}"
if [ ! -f "$TASKS_FILE" ]; then
  build_tasks_jsonl "$TASKS_FILE" > /dev/null
fi
require_file "$TASKS_FILE" "the benchmark task pool (TASKS_FILE or data/tasks/benchmark-tasks.jsonl)" > /dev/null

mkdir -p "$PROJECT_ROOT/data/teacher"
if ! run_worker synth_gen.py --in "$TASKS_FILE" --out "$PROJECT_ROOT/data/teacher/generated-tasks.jsonl"; then
  phase_fail "workers/synth_gen.py failed for $TASKS_FILE"
fi
manifest_add_artifact "$PROJECT_ROOT/data/teacher/generated-tasks.jsonl"

TEACHER_SOURCE=""
if [ -n "${TEACHER_ROWS:-}" ]; then
  TEACHER_ROWS="$(require_file "$TEACHER_ROWS" "the teacher rows file (TEACHER_ROWS)")"
  TEACHER_SOURCE="$TEACHER_ROWS"
elif [ -f "$PROJECT_ROOT/state/teacher_raw.jsonl" ]; then
  TEACHER_SOURCE="$PROJECT_ROOT/state/teacher_raw.jsonl"
elif [ -f "$PROJECT_ROOT/data/teacher/teacher-raw.jsonl" ]; then
  TEACHER_SOURCE="$PROJECT_ROOT/data/teacher/teacher-raw.jsonl"
else
  phase_fail "external prerequisite missing: no teacher rows. Set TEACHER_ROWS=<path> or provide state/teacher_raw.jsonl. Live teacher inference runs through the configured P2.1 phase command (state/phase-commands.json) on the teacher host, or via scripts/phases/pi-rollout.sh when the PI_* environment is configured; this script never calls a model endpoint itself."
fi
cp "$TEACHER_SOURCE" "$PROJECT_ROOT/data/teacher/teacher-raw.jsonl"
teacher_rows="$(wc -l < "$PROJECT_ROOT/data/teacher/teacher-raw.jsonl" | tr -d ' ')"
if [ "$teacher_rows" -lt 1 ]; then
  phase_fail "teacher rows file is empty: $TEACHER_SOURCE"
fi
manifest_add_artifact "$PROJECT_ROOT/data/teacher/teacher-raw.jsonl"

manifest_emit_success
