# WORKFLOW — MACHINE MIGRATION: Resume at P2.6 on a new 2×L4 host

**Target executor:** the Pi coding agent operating the new machine (or controlling it over SSH), with this document submitted as the sole task input.

**Primary adaptation:** this is the warm-start counterpart to [`workflow-phase1-remote-setup.md`](workflow-phase1-remote-setup.md). Phase 1 bootstraps an *empty* machine into a working environment. This document moves an *in-flight* workflow: machine 1 (a single 24 GB GPU) has completed phases **P0 through P2.5** with all durable state checkpointed to the Hugging Face artifact repository; machine 2 (2×L4) must recover that state and continue through **P2.6 → P2.6b → P2.7 → P2.8**, the phases that require or benefit from the two-GPU topology.

**Source of truth for state:** the Hugging Face durable repository, not any machine's local disk. The remote machine may disappear at any time.

**Golden rules:**

1. Never rerun a completed phase. Never regenerate completed teacher batches. Resume converts stale state; it does not repeat work.
2. Every step ends in a verification gate. Do not proceed after a failed gate.
3. Never echo tokens, API keys, private keys, or complete authenticated URLs.
4. Never use Ollama. Never execute model-generated shell scripts on the analysis Mac.

---

## 0. When to use this document

Use this document only when **all** of the following hold:

- The phase ledger shows P0, P2.0, P2.1, P2.2, P2.3, P2.4, and P2.5 with status `done`.
- The P2.5 completion gate passed: ledger, artifact manifest, artifacts, and checkpoint commit are pushed to the HF repository.
- Machine 1 is being retired or released; machine 2 provides **two** suitable GPUs (2×24 GB L4 or better).

Do **not** use this document for a cold start (no prior ledger) — use `workflow-phase1-remote-setup.md` instead. If the ledger does not exist or P0–P2.5 are not all `done`, stop and report; do not improvise.

---

## 1. What survives the migration and what dies with machine 1

| Survives (HF durable repository) | Dies with machine 1 (do not try to recover) |
|---|---|
| `state/phase-ledger.json` — phase statuses, attempts, cursors, commits | Running processes; pid/log files under `<remoteRoot>/state/ssh-jobs/` |
| `state/artifact-manifest.json` — every artifact with SHA-256 hashes | Machine-1 SSH job IDs (`ssh-...`): they will never resolve on machine 2 |
| `state/runs/<phaseId>/result.json` — per-phase result manifests | vLLM/llama.cpp model caches and serving processes |
| `data/` — generated tasks, teacher rows, verified rows | `$HOME/checkpoints/` intermediate training outputs superseded by pushed releases |
| `data/splits/` — train/eval/holdout splits (P2.2 output) | Rollout sandboxes under `$HOME/rollout-sandboxes/` |
| `artifacts/` — weakness profile, manifests, reward reports | Any shell state, environment variables, tmux sessions |
| `models/` — merged releases (SFT v0.1) with pinned revisions | |

Machine-1 job IDs are treated as **dead by design**. The resume step converts them to `interrupted`; it must never poll them as live jobs.

---

## 2. Machine-1 exit gate (run before decommissioning machine 1)

Run from the analysis Mac or machine 1, against the current durable state:

```text
Use `shell_specialization_status` and `shell_specialization_dashboard` to show the phase ledger. Confirm every phase P0 through P2.5 is `done` and no phase is `working` or `failed`. Then use `shell_specialization_artifacts` to list every durable artifact with its SHA-256 hash. Do not start any job.
```

Then verify the push state of the durable checkout:

```bash
git -C "$HOME/pi-shell-specialization-state" status --porcelain   # must be empty
git -C "$HOME/pi-shell-specialization-state" log origin/main..main --oneline  # must be empty
git -C "$HOME/pi-shell-specialization-state" rev-parse HEAD       # record this commit
```

Record in the migration note:

- The durable checkout commit hash (this is the recovery point).
- The SFT v0.1 release revision (P2.4 output) — this is the fallback release if the GRPO gate later fails.
- The list of machine-1 job IDs being consciously abandoned.

**Gate M1:** ledger clean (no `working`/`failed` phases), durable checkout fully pushed, recovery commit recorded. Only then may machine 1 be released.

---

## 3. Machine-2 bootstrap — Phase-1 runbook plus dual-GPU deltas

Execute `workflow-phase1-remote-setup.md` sections 3 through 9 on machine 2 exactly as written, with these deltas:

| Item | Single-GPU machine 1 | Machine 2 (this migration) |
|---|---|---|
| Gate 0 GPU preflight | one GPU listed | `nvidia-smi` must list **two distinct GPU ids** |
| GPU topology gate | "one 24 GB GPU" mode; P2.6 refused | article-style AsyncGRPO now applicable |
| `GRPO_GPUS` | unset | two distinct ids, e.g. `0,1` |
| `PI_GRPO_REQUIRE_2_GPU` | unset | unset or `1` — never overridden |
| P2.6 phase command | absent or blocked | `gpu` must be exactly `2xL4` (see section 5) |

Everything else — system utilities, Node 22 + Pi, Python/TRL/OpenEnv environments, GitHub/HF authentication, model and endpoint configuration, the `PI_*`/`STUDENT_*`/`TEACHER_*`/`VLLM_*` configuration contract — is identical to Phase 1. Re-serve the teacher endpoint only if P2.6+ needs it for anything other than rollouts; P2.1 teacher data is already durable and must never be regenerated.

Recommended directory layout (same as Phase 1):

```text
$HOME/pi-shell-specialization/        # GitHub code checkout
$HOME/pi-shell-specialization-state/  # HF durable state checkout
$HOME/models/                         # local model cache
$HOME/checkpoints/                    # temporary training outputs
$HOME/rollout-sandboxes/              # per-rollout isolated workspaces
```

**Gate M2:** `nvidia-smi` shows two GPUs; the Phase-1 exit-report checks for sections 3–9 pass; `GRPO_GPUS` lists two distinct ids.

---

## 4. Recover durable state

### 4.1 Clone both repositories

```bash
git clone https://github.com/rajivmehtaflex/pi-shell-specialization.git "$HOME/pi-shell-specialization"
git lfs install
git clone https://huggingface.co/rajivmehtapy/pi-shell-specialization "$HOME/pi-shell-specialization-state"
git -C "$HOME/pi-shell-specialization-state" lfs pull
```

Authenticate exactly as Phase 1 section 7 requires. Never echo the token.

### 4.2 Verify the ledger before touching anything

```bash
node -e "const l=require('$HOME/pi-shell-specialization-state/state/phase-ledger.json'); if(l.schemaVersion!==1) throw new Error('bad schema'); const bad=l.phases.filter(p=>['P0','P2.0','P2.1','P2.2','P2.3','P2.4','P2.5'].includes(p.id)&&p.status!=='done'); if(bad.length) throw new Error('not all P0-P2.5 done: '+JSON.stringify(bad.map(p=>[p.id,p.status]))); console.log('ledger OK, recovery point valid')"
```

**Stop conditions — halt and report, never repair silently:**

- The ledger file is missing or `schemaVersion` is not 1.
- Any of P0–P2.5 is not `done` (compare against the Gate M1 recovery commit; a mismatch means the durable checkout is not the one you recorded).
- `git -C "$HOME/pi-shell-specialization-state" rev-parse HEAD` differs from the Gate M1 recovery commit.

### 4.3 Resume

```text
Run `shell_specialization_resume`. Pull the durable ledger and artifact manifest, verify all recorded SHA-256 hashes, poll any saved SSH job IDs, convert stale phases to interrupted when necessary, and show me the exact next safe action. Do not rerun completed batches.
```

Expected resume behavior (implemented in the orchestrator):

- Every recorded artifact is re-hashed and compared to `state/artifact-manifest.json`.
- Phases left `working` by machine 1 are converted to `interrupted` with the reason "previous orchestrator stopped"; phases with saved job bindings get next action "poll saved remote job".
- Dead machine-1 job IDs fail status polling and resolve to `interrupted`, never `failed` by themselves.

**Stop conditions:**

- Any hash verification mismatch → halt. The durable state cannot be trusted; compare with the Gate M1 records.
- The reported next safe action is not P2.6 → halt and show the ledger; do not pick a phase by hand.

**Gate M3:** all hashes verified; resume reports P2.6 as the exact next safe action.

---

## 5. Configure the two GPU phases on machine 2

The extension launches only commands present in the allowlisted `state/phase-commands.json` (path relative to the orchestration root; override with `PI_PHASE_COMMANDS_FILE`). Missing phase commands are reported as `blocked` — they are never guessed or generated from model output.

Write/merge the GPU-phase entries:

```json
{
  "P2.6": {
    "command": "bash scripts/phases/p2-6-async-grpo.sh",
    "gpu": "2xL4",
    "timeoutSeconds": 28800,
    "estimatedCostUsd": 8,
    "estimatedGpuSeconds": 28800
  },
  "P2.7": {
    "command": "bash scripts/phases/p2-7-serve.sh",
    "gpu": "1xL4",
    "timeoutSeconds": 3600,
    "estimatedCostUsd": 1
  }
}
```

Validation rules enforced by the package (`runtime-config.ts`) — do not work around them:

- Every entry must declare a count-prefixed GPU string; a bare `L4` is rejected.
- The declared count is cross-checked against `requiredGpuCount` in `src/orchestrator/phase-types.ts`. **P2.6 requires exactly 2; declaring `1xL4` for P2.6 is a hard configuration error**, rejected before any SSH call.
- P2.6b (merge/upload) and P2.8 (export) are local phases — run them directly, not through this file.

P2.6 script prerequisites (enforced first, before anything else runs — `scripts/phases/p2-6-async-grpo.sh`):

```text
GRPO_GPUS              at least two distinct GPU ids, e.g. "0,1"
GRPO_COMMAND           the AsyncGRPO trainer launcher (one GPU serves the
                       policy vLLM, the other runs the TRL trainer);
                       first run must be a smoke run: small prompt count,
                       small step count, nonzero reward_std
data/splits/eval.jsonl the reward task split — arrives with the durable
                       checkout (P2.2 output); verify, never regenerate
PI_GRPO_REQUIRE_2_GPU  unset or "1"; there is no single-GPU fallback
```

Topology (article-style): GPU 0 serves the current student policy through vLLM behind the transparent proxy; GPU 1 runs the TRL AsyncGRPO trainer; reward comes only from hidden shell verification; the teacher is unavailable during rollouts.

**Gate M4:** `npm test`, `npm run build`, and `npm run validate` pass on machine 2; the one-prompt dry run (WORKFLOW_MODE unset) passes end-to-end with P2.6 shown as the next launchable phase. Only then continue.

---

## 6. Launch P2.6 and run through P2.8

Switch the mode only after Gate M4:

```bash
export WORKFLOW_MODE=live
```

### P2.6 — two-GPU AsyncGRPO sharpening

```text
Prepare phase P2.6, but do not launch until the ledger and hardware check confirm requiredGpuCount=2. Use GPU 0 for the current student policy vLLM server and GPU 1 for the TRL AsyncGRPO trainer. Run the real Pi loop-owning harness through the transparent proxy, capture tool-turn traces, calculate reward only from hidden shell verification, and keep the teacher unavailable during rollouts. Stop if two suitable GPUs are not visible. Persist state before launch, after remote job registration, and after every durable batch.
```

Quality gate before P2.6b: nonzero reward variance, no reward collapse, and improvement over the SFT v0.1 checkpoint. If the gate fails, SFT v0.1 remains the release and P2.6b is not run.

### P2.6b — merge and publish GRPO v0.2

```text
Run phase P2.6b only after GRPO finishes with nonzero reward variance, no reward collapse, and an improvement over the SFT checkpoint. Merge/export v0.2, record the pinned HF revision and hashes, and preserve SFT v0.1 as the fallback release.
```

### P2.7 — final serving smoke test

```text
Run phase P2.7 using the final student release. Serve it through the configured vLLM deployment, verify the OpenAI-compatible endpoint, test the 64K context configuration, and record health/model/tool-call smoke results.
```

### P2.8 — final Pi provider/export

```text
Run phase P2.8. Configure Pi to use the pinned final student endpoint, verify that the pi-shell-specialization extension loads, run one safe shell-coding smoke prompt in the external Linux sandbox, and publish the final deployment manifest. Do not run model-generated shell code on this Mac.
```

**Gate M5:** every phase P2.6 through P2.8 shows `done` in the ledger, and the final safety rule holds: persist state before launch, after remote job registration, after each durable batch, and after the completion gate. A phase is not done until its ledger, manifest, artifacts, and checkpoint commit are pushed.

---

## 7. Failure and rollback rules

| Failure | Required response |
|---|---|
| Artifact hash mismatch during resume | Halt. Do not re-download, regenerate, or "fix" artifacts. Compare against Gate M1 records. |
| Ledger differs from Gate M1 recovery commit | Halt. The durable checkout is not the recorded recovery point. |
| Only one GPU visible on machine 2 | P2.6 refuses by design (`require_two_gpus`, `requiredGpuCount=2`). Do not attempt a single-GPU variant, do not edit `phase-types.ts`. |
| P2.6 GRPO quality gate fails | Do not run P2.6b. SFT v0.1 stays the release. Any decision to serve v0.1 in P2.7 must be recorded explicitly in the ledger. |
| Machine 2 dies mid-P2.6 | Batch cursor, raw responses, and job IDs survive if checkpointed; this document applies again on the replacement machine. Uncheckpointed batches are lost and must be re-run from the last cursor — that is resume, not a violation of rule 1. |
| Phase command rejected ("requires 2 GPU(s)") | The configuration is wrong, not the validator. Fix `state/phase-commands.json`. |
| Any phase `failed` | Use the cancel/reset path (`shell_specialization_cancel`, `resetFailedPhase`), preserve batch cursor and raw artifacts, and show the resume command. Never delete persisted data. |

Never: use Ollama; execute model-generated scripts on the analysis Mac; bypass the phase-command allowlist; reveal hidden verifier details in teacher or rollout prompts.

---

## 8. Exit report

When P2.8 completes, record:

- Final ledger commit hash on the HF durable repository.
- Pinned release revision actually served (GRPO v0.2 or SFT v0.1 fallback) with SHA-256 hashes.
- GRPO reward summary: variance, absence of collapse, improvement measurement over SFT.
- P2.7 smoke results: endpoint health, 64K context verification, tool-call smoke.
- P2.8 deployment manifest location.
- Any phase that was interrupted, why, and how it was recovered.

The workflow is complete only when the exit report exists and the final ledger state is pushed.
