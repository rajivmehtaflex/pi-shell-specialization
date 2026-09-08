# RUNBOOK — P0→P2.5 by phase scripts (no orchestrator)

Simplified solo path: run the `scripts/phases/*.sh` directly on the GPU machine and push the state repo after each phase. Skips the Pi tools, ledger, dashboard, `state/phase-commands.json`, and dry-run/live mode. Every script fails fast on missing prerequisites and emits `state/runs/<phase>/result.json` with real SHA-256 artifact hashes — those manifests, not a ledger, are your durable state.

Machine setup is unchanged: bootstrap with [`workflow-phase1-remote-setup.md`](workflow-phase1-remote-setup.md) (Gate 0 → §9). Before starting: HF repo `rajivmehtapy/pi-shell-specialization` exists; `HF_TOKEN` (write), `GH_TOKEN` configured; teacher (≤30B-class GGUF for 24 GB VRAM) and student (`STUDENT_MODEL_ID`/`STUDENT_REVISION`) chosen. Never run these on the Mac; never use Ollama.

## The loop

| # | Command | You must provide | Done when |
|---|---|---|---|
| 0 | `npm run build` | — | `dist/` built, `npm run validate` → `valid: 60 cases` |
| 1 | `bash scripts/phases/p0-baseline.sh` | `EVAL_BASELINE_COMMAND` — evaluates the base model on the 60-case benchmark (without it the phase only exports sanitized questions, no weakness profile) | `state/runs/P0/result.json` + `artifacts/p0/` |
| 2 | `bash scripts/phases/p2-0-data-foundation.sh` | nothing (local; writes `data/tasks/benchmark-tasks.jsonl`) | task pool exists |
| 3 | `bash scripts/phases/p2-1-teacher-inference.sh` | `TEACHER_ROWS=<path>` — teacher envelope-rows JSONL you generated against your llama.cpp endpoint (the script itself never calls a model). Resume: if `data/teacher/teacher-raw.jsonl` already exists, you may omit this | `data/teacher/teacher-raw.jsonl` |
| 4 | `bash scripts/phases/p2-2-audit-split.sh` | nothing (local, CPU-only: verify → audit → split → gate). Smoke only: `PI_DATASET_GATE=dry-run` | live gate passed: train ≥ 1800, eval = 250, holdout = 250, balanceDelta ≤ 0.1 → `data/splits/{train,eval,holdout}.jsonl`. **If the gate fails: generate more teacher data. Never lower the gate.** |
| 5 | `bash scripts/phases/p2-3-sft.sh` | `TRAIN_SFT_COMMAND` — your QLoRA/SFT launcher. Smoke first (e.g. `--max-steps 5`), then the full 3-epoch run | `state/runs/P2.3/result.json` + `artifacts/sft/` |
| 6 | `bash scripts/phases/p2-4-merge-upload.sh` | `MERGE_UPLOAD_COMMAND` — merges the adapter and pushes SFT v0.1 to the HF remote (never overwrite an existing revision). Records `HF_REVISION` | revision pinned in `artifacts/sft/hf-revision.txt` |
| 7 | `bash scripts/phases/p2-5-eval.sh` | `EVAL_COMMAND` — evaluates base vs student over `data/splits/holdout.jsonl` with the same verifier, writes summary JSON | improvement-gate verdict in `artifacts/eval/summary.json` |

**After every phase, one line of durability:**

```bash
git -C ~/pi-shell-specialization-state add state data artifacts runs 2>/dev/null; \
git -C ~/pi-shell-specialization-state commit -m "phase <ID>" && git -C ~/pi-shell-specialization-state push
```

(Run from your state checkout root, or keep one checkout that holds both code and state.)

## Recovery and rules

- A failed script is safe to re-run after fixing the prerequisite it names — nothing is partially committed; manifests are written only on completion.
- Machine loss: clone the state repo on the replacement machine, spot-check hashes (`state/runs/*/result.json` records them), and continue at the first incomplete phase. P2.1 resumes from the existing `teacher-raw.jsonl`; completed teacher batches are never regenerated.
- A phase before P2.6 failing its gate is a stop, not a workaround: no GRPO if P2.5's improvement gate fails.
- `workers/verify.py` needs Linux + bubblewrap — this runbook assumes you are on the Linux GPU host, which is the point.

## P2.6 handoff

Stay script-driven on the 2×L4 machine: clone the state repo, then `GRPO_GPUS="0,1" GRPO_COMMAND=<TRL AsyncGRPO launcher> bash scripts/phases/p2-6-async-grpo.sh` (hard two-GPU gate runs first; smoke before the real run), then P2.6b → P2.7 → P2.8 the same way. Note: [`workflow-p26-machine-migration.md`](workflow-p26-machine-migration.md) assumes the orchestrator ledger; on the script-driven path the equivalent of its Gate M1/M3 is "state repo cloned, manifests and hashes verified, first incomplete phase identified."
