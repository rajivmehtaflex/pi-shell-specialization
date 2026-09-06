#!/usr/bin/env bash
# pi-rollout.sh -- run ONE Pi rollout through remote/pi_env.runtime and write
# the canonical envelope row. Helper for teacher-inference phases; this is
# NOT a phase script and emits no result manifest.
#
# Prerequisites (remote/pi_env/config.py load_config fails fast on these):
#   PI_COMMAND, PI_MODEL, PI_EXTENSION_PATH, PI_ENDPOINT_URL, PI_SANDBOX_ROOT
#     (PI_TIMEOUT_SECONDS optional) -- the Pi binary and model endpoint are
#     external prerequisites;
#   PI_TASK_FILE -- path to one task JSON with task_id/prompt/setup_files/
#     environment/checks (see remote/pi_env/task.py).
# Output:
#   data/pi_rollouts/<task_id>.json            canonical envelope row
#   data/pi_rollouts/<task_id>/                harness trace/aux artifacts
# The only network traffic is the configured model endpoint (this IS the
# network phase); nothing is pushed anywhere.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

require_env PI_COMMAND "the Pi CLI launch command (remote/pi_env PiConfig)" > /dev/null
require_env PI_MODEL "the model id served at PI_ENDPOINT_URL" > /dev/null
require_env PI_EXTENSION_PATH "path to the pi-shell-specialization extension loaded into Pi" > /dev/null
require_env PI_ENDPOINT_URL "OpenAI-compatible base URL of the model endpoint" > /dev/null
require_env PI_SANDBOX_ROOT "disposable sandbox root under which every rollout workspace is created" > /dev/null
PI_TASK_FILE="$(require_env PI_TASK_FILE "path to one Pi task JSON file")"
PI_TASK_FILE="$(require_file "$PI_TASK_FILE" "the Pi task JSON file (PI_TASK_FILE)")"
require_command python3 "python3 must be installed" > /dev/null

mkdir -p "$PROJECT_ROOT/data/pi_rollouts"
if ! ( cd "$REPO_ROOT" && PROJECT_ROOT="$PROJECT_ROOT" python3 - <<'PY'
import json
import os
import re
import sys

sys.path.insert(0, os.getcwd())
from remote.pi_env.runtime import load_config, run_rollout
from workers.contracts import validate_envelope

root = os.environ["PROJECT_ROOT"]
with open(os.environ["PI_TASK_FILE"], encoding="utf-8") as handle:
    task = json.load(handle)

config = load_config()  # ValueError listing every problem when PI_* is incomplete
task_id = re.sub(r"[^A-Za-z0-9._-]", "_", str(task.get("task_id") or task.get("id") or "task"))
rollout_dir = os.path.join(root, "data", "pi_rollouts")
artifact_dir = os.path.join(rollout_dir, task_id)
row = run_rollout(task, config=config, artifact_dir=artifact_dir)

problems = validate_envelope(row)
if problems:
    print("rollout envelope is not canonical: " + "; ".join(problems), file=sys.stderr)
    sys.exit(1)

out_path = os.path.join(rollout_dir, task_id + ".json")
with open(out_path, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(row, sort_keys=True) + "\n")
print(json.dumps({"task_id": task_id, "envelope": os.path.relpath(out_path, root), "artifacts": os.path.relpath(artifact_dir, root)}))
PY
); then
  phase_fail "Pi rollout failed; check the PI_* environment (remote/pi_env.config.load_config) and the model endpoint"
fi

printf 'envelope written under %s\n' "$PROJECT_ROOT/data/pi_rollouts"
