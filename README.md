# pi-shell-specialization

Pi-extension-integrated Bash diagnostic benchmark for identifying weak points in `qwen3.5:9b` before shell-specialization work.

## Install from GitHub

Clone the public repository under the `rajivmehtaflex` GitHub account:

```bash
git clone https://github.com/rajivmehtaflex/pi-shell-specialization.git
cd pi-shell-specialization
npm install
npm run build
npm test
```

Load the package directly in Pi from the package directory:

```bash
pi -e ./src/index.ts
```

To load it from a Pi workspace, add the package path to that workspace's `.pi/settings.json`:

```json
{
  "packages": ["../packages/pi-shell-specialization"],
  "extensions": ["../packages/pi-shell-specialization/src/index.ts"]
}
```

Then confirm the extension is discovered:

```bash
pi list
```

## Sample Pi coding-agent prompts

These prompts are intended for the Pi coding agent after the extension is loaded:

### Inspect the question bank

```text
Use the shell benchmark question-list tool and show me the 10 hardest Linux Bash 5/GNU questions. Do not run any generated script.
```

### Start a controlled diagnostic session

```text
Start a raw shell diagnostic session for qwen3.5:9b with one attempt per question. Show me the session ID and the first question. Do not call Ollama locally.
```

### Record an external model response

````text
Record this externally generated response for the current shell session and case ID quote-001. Do not execute it:

```bash
cp "$INPUT_FILE" "$TEST_ROOT/copied.txt"
```
````

### Import external evaluation results

```text
Import `results/external-results.jsonl`, reject malformed or duplicate records, and summarize how many records were accepted. Do not execute any response during import.
```

### Generate the weakness report

```text
Build the shell weakness profile from `results/imported.json`. Separate capability failures from protocol and evaluator failures, and recommend which shell categories should receive teacher-generated data.
```

### Review the specialization handoff

```text
Read the weakness profile and prepare a weakness-conditioned teacher prompt for Linux Bash 5/GNU. Target repeated word-splitting failures, but do not reveal hidden verifier details to the teacher task prompt.
```

During development and local testing, explicitly tell Pi not to invoke Ollama or run model-generated scripts on the Mac. Real evaluation belongs in the external Linux sandbox/SSH GPU workflow.

## Remote environment setup

Before completing the pending Pi/OpenEnv harness and external-GPU phases, follow [`docs/workflow-phase1-remote-setup.md`](docs/workflow-phase1-remote-setup.md). It adds the HF/GitHub/SSH/teacher/model gates, durable checkpoint handoff, Linux smoke-test procedure, and the explicit policy that Ollama is excluded from this flow.

## Scope

The package contains **60 deterministic shell cases** across eight capability categories:

- Bash syntax and script structure
- Quoting, expansion, globbing, and arrays
- Files, paths, permissions, and text processing
- Pipelines, streams, and command substitution
- Error handling, traps, cleanup, and idempotence
- Security and command-injection resistance
- Debugging and repairing broken scripts
- Multi-step Pi terminal workflows

It provides:

- A public question list that does not expose fixtures or verifiers
- Private fixture and verification metadata for an external evaluator
- Strict single-Bash-fence parsing
- Static safety checks
- Sandbox execution support for a separately controlled evaluator
- Independent raw and Pi-tools tracks
- Session sequencing and response recording through Pi tools
- External JSONL result validation and import
- Category/difficulty/failure-label weakness analysis
- Wilson uncertainty intervals, pass@1/pass@N, curriculum mix, and teacher/control comparisons

## Important safety boundary

This package can invoke a model and execute generated scripts through the existing `run` command. **Do not use that command on the analysis Mac for this project.** The intended workflow is:

1. Export a bundle from this package.
2. Ask the target model the public questions in a separate disposable evaluator.
3. Execute generated scripts there with hidden fixtures and verifiers.
4. Import the resulting JSONL here.
5. Generate the weakness profile here without invoking Bash, Pi, or Ollama.

Import and report commands are analysis-only.

## Tests and build

```bash
npm test              # TypeScript tests under src/ and scripts/
npm run build
npm run validate      # node dist/src/cli.js validate
npm run test:workers  # python data-worker suite (workers/worker_tests)
npm run test:pi       # python Pi/OpenEnv adapter suite (remote/pi_env/tests)
npm run test:python   # both python suites
```

The phase scripts under `scripts/phases/` carry their own `node:test` suite (`scripts/phases.test.ts`): every script must pass `bash -n`, emit a contract-valid result manifest, hash artifacts with real sha256 digests, and refuse missing prerequisites.

## Public questions

Export sanitized questions after building:

```bash
node dist/src/cli.js questions --public --out questions/shell-questions-60-public.json
node dist/src/cli.js questions --public --out questions/shell-questions-60-public.md
```

The canonical source is `src/cases.ts`; generated public artifacts are under `questions/`.

## Create an external-evaluator bundle

```bash
node dist/src/cli.js export-bundle --out /tmp/shell-benchmark-bundle
```

The bundle includes:

- `questions/shell-questions-60-public.md`
- `questions/shell-questions-60.json`
- `questions/shell-questions-60-private.json`
- `RESULT-SCHEMA.md`
- `README.md`

The private file is for the evaluator only. Never include its fixture or verifier data in the model prompt.

## Import external results and report weaknesses

```bash
node dist/src/cli.js import-results \
  --input /path/to/external-results.jsonl \
  --out results/imported.json

node dist/src/cli.js report \
  --input results/imported.json \
  --out results/WEAKNESS-PROFILE.md
```

Optional control comparison:

```bash
node dist/src/cli.js report \
  --input results/student.json \
  --control-input results/teacher.json \
  --out results/WEAKNESS-PROFILE.md
```

The report separates:

- Capability failures that may justify teacher-data generation
- Protocol failures such as missing code fences
- Evaluator failures such as unavailable sandboxes or bad fixtures

Only repeated, machine-verified capability failures should drive specialization data.

## Pi tools

The extension registers:

- `shell_benchmark_cases` — sanitized metadata tool; returns the public model-facing questions only (prompts and metadata; fixtures, verifiers, and expected exit codes are never exposed, and generated scripts may only be executed in the separate sandboxed runner)
- `shell_benchmark_question_list` — filtered public questions
- `shell_benchmark_start` — controlled diagnostic session
- `shell_benchmark_next` — next public question
- `shell_benchmark_record_response` — record a response without executing it
- `shell_benchmark_import_results` — validate external JSONL
- `shell_benchmark_weakness_report` — generate a weakness report from external results
- `shell_specialization_status` — read the durable phase ledger
- `shell_specialization_run_next` — run the next dependency-ready phase
- `shell_specialization_run_phase` — run one named phase through the orchestrator
- `shell_specialization_resume` — recover stale phases and poll saved SSH jobs
- `shell_specialization_cancel` — cancel a saved SSH job
- `shell_specialization_dashboard` — render the phase table in Pi
- `shell_specialization_artifacts` — list durable artifacts and hashes

The orchestration surface is provider-neutral and SSH-based. It does not require Modal. The phase ledger records the compute topology: P2.6 article-style AsyncGRPO requires two GPUs, while teacher inference, SFT, evaluation, and final serving are sequential single-GPU phases.

## Implementation status

**Implemented and locally verified (no GPU, no network, no push required):**

- Canonical envelope contracts and scoring/cohort fixes (`workers/verify.py` requires at least one substantive, non-`exit_code` check per task; designed failure labels only attach to genuine execution failures)
- Sandbox verifier isolation (candidate code can never read or forge the verifier tree)
- Production split quotas and the category-balance gate (`workers/split.py`: eval=250, holdout=250, >= 2300 accepted rows, `balanceDelta <= 0.1`)
- SSH outcome-aware orchestration and job reconciliation, checkpoint allowlist plus hash-verified recovery (`src/orchestrator/`)
- Pi/OpenEnv adapter core and rollout harness (`remote/pi_env/`: `run_rollout`, `load_config`, `RolloutHarness`)
- Honest dry-run: local phases run with real gates, remote phases are simulated, and live mode refuses to start without a real checkpoint
- Phase scripts with result-manifest emission (`scripts/phases/`, see below)

**External prerequisites (the package fails fast with a clear error when these are missing):**

- A Linux evaluator with bubblewrap for the full sandbox path (macOS falls back to fail-closed)
- An SSH GPU host (`PI_SSH_HOST`, `PI_SSH_USER`, `PI_SSH_REMOTE_ROOT`, optional `PI_SSH_PORT`, `PI_SSH_IDENTITY_FILE`)
- GPUs: one for teacher inference/SFT/eval/serve; two for P2.6 AsyncGRPO (hard gate)
- The Pi CLI binary plus an OpenAI-compatible model endpoint (`PI_COMMAND`, `PI_MODEL`, `PI_EXTENSION_PATH`, `PI_ENDPOINT_URL`, `PI_SANDBOX_ROOT`)
- The llama.cpp offline teacher endpoint and HF remote for checkpoint sync

## Phase scripts

Every phase has one bash script under `scripts/phases/`, named after the phase ids in `src/orchestrator/phase-types.ts`. Each script sources `scripts/phases/lib.sh` and follows one contract:

- strict mode (`set -euo pipefail`);
- it writes a result manifest at `state/runs/<phaseId>/result.json` shaped exactly like the orchestrator contract (`{"phase", "status": "success"|"failed", "artifacts": [{"path", "sha256"}], "completedAt", "error"?}`);
- artifact digests are real sha256 sums (`shasum -a 256`, falling back to `sha256sum`), because resume recomputes them — a fake hash marks the phase failed;
- artifact paths must live under `state/`, `data/`, `artifacts/`, or `runs/` (the checkpoint commit allowlist);
- missing external prerequisites produce a failed manifest with a clear "external prerequisite missing" message and a nonzero exit;
- scripts never push and never need the network for their local-verifiable steps.

| Script | Phase | Local-verifiable | External prerequisite |
|---|---|---|---|
| `p0-baseline.sh` | P0 Baseline weakness profile | toolchain checks, `validate`, sanitized question export | optional `EVAL_BASELINE_COMMAND` for the real base eval |
| `p2-0-data-foundation.sh` | P2.0 Shell data foundation | benchmark test selection, validation, task pool at `data/tasks/benchmark-tasks.jsonl` | none |
| `p2-1-teacher-inference.sh` | P2.1 Teacher inference | task synthesis (`workers/synth_gen.py`) | `TEACHER_ROWS` / `state/teacher_raw.jsonl`, or the configured P2.1 command on the teacher host |
| `p2-2-audit-split.sh` | P2.2 Dataset audit and split | `workers/verify.py` + `workers/teacher_audit.py` + `workers/split.py` + numeric dataset gate (`artifacts/dataset-gate.json`) | teacher rows from P2.1 |
| `p2-3-sft.sh` | P2.3 QLoRA/SFT | runs `TRAIN_SFT_COMMAND` and captures logs/artifacts | GPU host + trainer command |
| `p2-4-merge-upload.sh` | P2.4 Merge and upload v0.1 | runs `MERGE_UPLOAD_COMMAND`, records the pinned revision | merge + HF push host |
| `p2-5-eval.sh` | P2.5 Base/student evaluation | runs `EVAL_COMMAND` over the holdout | GPU host + eval command |
| `p2-6-async-grpo.sh` | P2.6 GRPO sharpening | runs `GRPO_COMMAND` after the two-GPU gate | `GRPO_GPUS` with >= 2 distinct ids, trainer command |
| `p2-6b-merge-upload.sh` | P2.6b Merge and upload v0.2 | runs `GRPO_MERGE_UPLOAD_COMMAND` after a successful P2.6 | merge + HF push host |
| `p2-7-serve.sh` | P2.7 Serve at 64K | runs `SERVE_COMMAND` smoke against the pinned release | vLLM/llama.cpp deployment |
| `p2-8-export.sh` | P2.8 Pi provider and final export | evaluator bundle + Pi provider config + deployment manifest under `artifacts/export/` | none |

`scripts/phases/pi-rollout.sh` is a helper (not a phase): it runs one Pi rollout through `remote/pi_env.runtime` and writes the canonical envelope row to `data/pi_rollouts/<task_id>.json` when the `PI_*` environment is complete.

The P2.6 gate is hard: `GRPO_GPUS` must list at least two distinct GPU ids (for example `GRPO_GPUS=0,1`), `PI_GRPO_REQUIRE_2_GPU` must be `1` or unset, and there is no single-GPU fallback.

## Acceptance and resume commands

```bash
npm test                 # TypeScript + phase-script tests
npm run build
npm run validate
npm run test:python      # workers (71) + pi_env (136) suites

# One-prompt dry run (no SSH executor, no real checkpoint, no pushes):
WORKFLOW_MODE unset      # dry-run is the default
pi -e ./src/index.ts     # then: shell_specialization_run_next / _resume / _dashboard

# One phase script directly (local-verifiable phases run anywhere):
bash scripts/phases/p2-2-audit-split.sh      # uses state/teacher_raw.jsonl
PHASE_PROJECT_ROOT=/tmp/sandbox bash scripts/phases/p0-baseline.sh

# Live mode requires ALL of:
WORKFLOW_MODE=live
#   a configured checkpoint (HF remote: PI_SSH_* env + phase commands, git-backed HfGitSync),
#   SSH env vars (PI_SSH_HOST, PI_SSH_USER, PI_SSH_REMOTE_ROOT),
#   state/phase-commands.json entries whose gpu strings declare an explicit count prefix
#   ("1xL4", "2xA100" — bare "L4" is rejected; override the path with PI_PHASE_COMMANDS_FILE).
```

`shell_specialization_resume` reloads the ledger, recovers stale working phases, reconciles saved SSH jobs, re-verifies every recorded artifact hash, and reports the next safe action.

## Phase-by-phase Pi prompts

Run these prompts after Pi has loaded the extension and the SSH runtime configuration is available. Start with `WORKFLOW_MODE=dry-run`; switch to `live` only after the one-prompt dry run passes.

### Before starting: inspect the control plane

```text
Use `shell_specialization_status` and `shell_specialization_dashboard` to show the current phase ledger. Confirm the mode, SSH-backed runtime, artifact repository, and required GPU count for every phase. Do not start a job and do not use Ollama.
```

### P0 — baseline weakness profile

```text
Run phase P0 through the configured SSH phase command. Evaluate the base student on the Linux Bash 5/GNU diagnostic track, write the weakness profile and artifact manifest, and checkpoint the phase before launch and after completion. Do not execute generated scripts on this Mac and do not use Ollama.
```

### P2.0 — shell data foundation

```text
Run phase P2.0 after confirming P0 is done. Generate weakness-conditioned shell tasks from the persisted weakness profile, keep hidden verifier details private, validate the task schema, and checkpoint the generated prompt artifacts to the durable repository.
```

### P2.1 — teacher inference

```text
Run phase P2.1 through the configured llama.cpp teacher endpoint. Generate teacher solutions for the persisted shell tasks in resumable batches. Save the request IDs, batch cursor, raw responses, and checkpoint after every durable batch. Do not use Ollama and do not provide teacher assistance during future GRPO rollouts.
```

### P2.2 — teacher verification and dataset split

```text
Run phase P2.2. Verify teacher-generated Bash answers in the isolated Linux evaluator, reject unsafe or incorrect answers, remove duplicates and leakage, and create disjoint train/eval/holdout splits. Stop if the production dataset gate fails; do not silently continue with undersized data.
```

### P2.3 — QLoRA/SFT

```text
Run phase P2.3 on the verified dataset using the trainable student checkpoint and the configured QLoRA/SFT settings. The teacher must not be loaded as a live co-pilot. Record training metrics, checkpoint paths, hashes, and the remote job ID before returning.
```

### P2.4 — merge and publish SFT v0.1

```text
Run phase P2.4. Merge the verified SFT adapter into the student release artifact, validate tokenizer/config files, record the HF revision and hashes, and push only allowlisted model metadata and Git-LFS artifacts. Do not overwrite an existing release revision.
```

### P2.5 — base versus SFT evaluation

```text
Run phase P2.5 on the hidden holdout set. Compare the original base student with SFT v0.1 using the same Linux Bash 5/GNU tasks and verifier. Report category-level pass rates, failures, confidence intervals, and whether SFT clears the improvement gate. Do not start GRPO if the gate fails.
```

### P2.6 — two-GPU AsyncGRPO sharpening

```text
Prepare phase P2.6, but do not launch until the ledger and hardware check confirm requiredGpuCount=2. Use GPU 0 for the current student policy vLLM server and GPU 1 for the TRL AsyncGRPO trainer. Run the real Pi loop-owning harness through the transparent proxy, capture tool-turn traces, calculate reward only from hidden shell verification, and keep the teacher unavailable during rollouts. Stop if two suitable GPUs are not visible.
```

### P2.6b — merge and publish GRPO v0.2

```text
Run phase P2.6b only after GRPO finishes with nonzero reward variance, no reward collapse, and an improvement over the SFT checkpoint. Merge/export v0.2, record the pinned HF revision and hashes, and preserve SFT v0.1 as the fallback release.
```

### P2.7 — final serving smoke test

```text
Run phase P2.7 using the final student release. Serve it through the configured vLLM or llama.cpp deployment, verify the OpenAI-compatible endpoint, test the target context configuration, and record health/model/tool-call smoke results. This phase normally requires one GPU, not two.
```

### P2.8 — final Pi provider/export

```text
Run phase P2.8. Configure Pi to use the pinned final student endpoint, verify that the pi-shell-specialization extension loads, run one safe shell-coding smoke prompt in the external Linux sandbox, and publish the final deployment manifest. Do not run model-generated shell code on this Mac.
```

### Resume after SSH machine loss

```text
The SSH machine was replaced. Run `shell_specialization_resume`, pull the durable ledger and artifact manifest, verify all recorded hashes, poll any saved SSH job IDs, convert stale phases to interrupted when necessary, and show me the exact next safe action. Do not rerun completed batches.
```

### Inspect artifacts and stop a job

```text
Use `shell_specialization_artifacts` to list every durable artifact, phase, and SHA-256 hash. Then show the phase dashboard and identify any phase whose local state has not been pushed.
```

```text
Cancel the remote job for phase P2.1, mark it interrupted with the reason, preserve its batch cursor and raw artifacts, and show the resume command. Do not delete the persisted data.
```

### Final safety rule

```text
For every phase, persist state before launch, after remote job registration, after each durable batch, and after the completion gate. A phase is not done until its ledger, manifest, artifacts, and checkpoint commit are pushed. Never use Ollama.
```

## Training handoff

The benchmark is Stage 0 of the specialization pipeline:

```text
60-case evaluation
    ↓
weakness profile
    ↓
teacher generates verified examples around confirmed weaknesses
    ↓
SFT/response distillation of a trainable Qwen3.5-9B checkpoint
    ↓
optional GRPO sharpening in Pi/OpenEnv-style external sandboxes
    ↓
held-out regression evaluation
    ↓
GGUF/export for deployment
```

The benchmark itself does not implement distillation or GRPO training. It supplies the measured weaknesses, verified tasks, and reward-task candidates for those later stages.
