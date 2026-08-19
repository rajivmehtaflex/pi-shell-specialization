# WORKFLOW — PHASE 1: SSH GPU Environment Setup and Pi/OpenEnv Harness Bootstrap

**Target executor:** an SSH-accessible Linux GPU machine

**Primary adaptation:** replace the article's OpenCode harness with a Pi coding-agent harness.

**Source material:**

- Hugging Face article: <https://huggingface.co/blog/sergiopaniego/trl-openenv-harness-training>
- Official TRL local harness example: <https://github.com/huggingface/trl/blob/main/examples/scripts/openenv/opencode.py>
- Official TRL remote-sandbox example: <https://github.com/huggingface/trl/blob/main/examples/scripts/openenv/opencode_hf_sandbox.py>
- OpenEnv/TRL harness documentation: <https://huggingface.co/docs/openenv/tutorials/opencode-agent-grpo>

**Goal:** prepare an SSH-connected machine with the shell-specialization package, Pi, TRL/OpenEnv, vLLM, training dependencies, model access, and durable repository access. After this workflow passes, the pending Pi orchestrator, harness adapter, phase tools, dashboard, resume bootstrap, and first external smoke phase can be completed on that machine.

**Golden rule:** every step is idempotent and ends in a verification gate. Do not proceed after a failed gate. Never echo tokens, API keys, private keys, or complete authenticated URLs.

---

## 0. Architecture: article design adapted for Pi

The article's loop-owning architecture is:

```text
coding-agent harness owns its tool loop
        ↓
isolated sandbox per rollout
        ↓
transparent OpenAI-compatible proxy
        ↓
per-turn token IDs/logprobs trace
        ↓
hidden verifier calculates reward
        ↓
TRL HarnessRolloutWorker
        ↓
AsyncGRPOTrainer
```

For this project, the harness becomes Pi:

```text
Pi CLI + pi-shell-specialization extension
        ↓
PiSessionFactory / PiSandboxBackend                 [to implement]
        ↓
Pi runs its own tool loop in an isolated workspace
        ↓
transparent proxy captures Pi model calls
        ↓
hidden shell verifier calculates reward
        ↓
TRL HarnessRolloutWorker
        ↓
AsyncGRPOTrainer
```

Replacing OpenCode with Pi requires a real adapter. It is **not** sufficient to rename `opencode` in the article's script. The package must provide:

```text
PiConfig
PiTask
PiSessionFactory
PiSandboxBackend
PiSession
Pi proxy/trace integration
Pi tool-turn filtering
Pi shell verifier integration
```

The existing `pi-shell-specialization` TypeScript package supplies the benchmark, verifier concepts, ledger, artifact manifest, teacher client, dry-run, and data gates. The Pi/OpenEnv harness adapter remains a pending implementation task.

---

## 1. Repository topology and durable state

Use two repositories:

```text
GitHub source repository:
https://github.com/rajivmehtaflex/pi-shell-specialization

Hugging Face durable artifact/model repository:
https://huggingface.co/rajivmehtapy/pi-shell-specialization
```

Recommended remote-machine directories:

```text
$HOME/pi-shell-specialization/        # GitHub package checkout
$HOME/pi-shell-specialization-state/  # HF durable state/data/model checkout
$HOME/models/                         # local model cache
$HOME/checkpoints/                    # temporary training outputs
$HOME/rollout-sandboxes/              # per-rollout isolated workspaces
```

The HF repository must hold:

```text
state/phase-ledger.json
state/artifact-manifest.json
state/resume.json
artifacts/
data/
runs/
models/
```

The remote machine may disappear. The HF repository, not the machine's local disk, is the recovery source of truth.

---

## 2. Non-secret configuration contract

Configure these values through the SSH machine's secret/environment mechanism. Never commit the real file.

```text
CODE_REPO=https://github.com/rajivmehtaflex/pi-shell-specialization
HF_ARTIFACT_REPO=rajivmehtapy/pi-shell-specialization
CODE_GITHUB_ACCOUNT=rajivmehtaflex
HF_ACCOUNT=rajivmehtapy
WORKFLOW_MODE=dry-run
TARGET_SHELL_DIALECT=linux-bash5-gnu

# Pi
PI_MODEL=<student model served by vLLM>
PI_PACKAGE_PATH=$HOME/pi-shell-specialization
PI_EXTENSION_PATH=$HOME/pi-shell-specialization/src/index.ts
PI_SANDBOX_ROOT=$HOME/rollout-sandboxes

# SSH executor used when Pi controls a separate GPU host
PI_SSH_HOST=<ssh-host>
PI_SSH_USER=<ssh-user>
PI_SSH_PORT=22
PI_SSH_REMOTE_ROOT=<remote-workflow-root>
PI_SSH_IDENTITY_FILE=<local-key-path-not-committed>

# Student used for SFT, GRPO, evaluation, and policy serving
STUDENT_MODEL_ID=<trainable Transformers checkpoint>
STUDENT_REVISION=<pinned revision or commit>

# Optional offline teacher-data phase
TEACHER_MODEL_REPO=<GGUF repository or endpoint owner>
TEACHER_GGUF_FILE=<exact GGUF filename if served locally>
TEACHER_BASE_URL=<OpenAI-compatible llama.cpp URL ending in /v1>
TEACHER_MODEL=<served teacher model name>

# Policy vLLM used by Pi rollouts
VLLM_LOCAL_URL=http://127.0.0.1:8000/v1
SANDBOX_VLLM_URL=<reachable URL only when using remote sandboxes>
VLLM_TOOL_CALL_PARSER=<model-compatible parser>
```

Secrets required at runtime:

```text
HF_TOKEN
GH_TOKEN, if gh uses token-based noninteractive authentication
TEACHER_API_KEY, if the teacher endpoint requires one
VLLM_API_KEY, if the policy server requires one
```

Do not put these values in Git remotes, `.env` files committed to a repository, process listings, reports, or chat messages.

---

## 3. Gate 0: SSH and hardware preflight

Run this on the SSH-connected machine:

```bash
set -u
printf 'hostname: '; hostname
printf 'user: '; id -un
printf 'working directory: '; pwd
printf 'architecture: '; uname -m
printf 'OS: '; sed -n '1,2p' /etc/os-release
printf 'CPU cores: '; nproc
printf 'RAM: '; free -h | sed -n '2p'
printf 'disk: '; df -h "$HOME" | sed -n '2p'
printf 'GPU: '; nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv
printf 'CUDA: '; nvidia-smi | sed -n 's/.*CUDA Version: /CUDA Version: /p' | sed -n '1p'
printf 'Bash: '; bash --version | sed -n '1p'
```

Minimum for the complete workflow:

| Resource | Minimum | Preferred |
|---|---:|---:|
| OS | Linux x86_64 | Ubuntu/Debian x86_64 |
| GPU | 24 GB VRAM for smoke/inference | 2 GPUs for article-style AsyncGRPO |
| CPU | 8 cores | 12–16 cores |
| System RAM | 32 GB | 64 GB |
| Persistent disk | 100 GB | 120 GB+ |
| CUDA | `nvidia-smi` visible | driver compatible with selected PyTorch/vLLM |
| Shell | Bash 5.x | Bash 5.x + GNU utilities |
| Node | Node 22 | Node 22 via nvm |

**Important:** 16 GB system RAM is not a supported target for the complete training workflow. It may pass a small inference smoke test but is below the safe SFT/GRPO environment requirement.

### GPU topology gate

The article's exact AsyncGRPO setup uses:

```text
GPU 0: vLLM serving the current policy and handling weight sync
GPU 1: AsyncGRPO trainer
```

Therefore:

```text
one 24 GB GPU:
  supported for package tests, Pi harness smoke, black-box evaluation,
  teacher generation, and sequential SFT experiments

exact article-style AsyncGRPO with live NCCL weight sync:
  requires two suitable GPUs or an explicitly implemented alternative
```

Do not silently claim the two-GPU AsyncGRPO design is available on one L4.

Record hardware:

```bash
mkdir -p "$HOME/pi-shell-specialization/setup"
{
  date -u
  hostname
  uname -a
  sed -n '1,12p' /etc/os-release
  nproc
  free -h
  df -h "$HOME"
  nvidia-smi
} > "$HOME/pi-shell-specialization/setup/env_report.txt"
```

**Gate 0:** SSH works, the persistent disk is mounted, GPU/CUDA are visible, and RAM/disk meet the selected execution mode.

---

## 4. Install system utilities

Install the shell, build, source-control, JSON, and process utilities required by Pi, the verifier, and OpenEnv sandboxes.

```bash
if command -v apt-get >/dev/null 2>&1; then
  sudo_cmd=""
  if command -v sudo >/dev/null 2>&1; then sudo_cmd="sudo"; fi
  $sudo_cmd apt-get update -qq
  $sudo_cmd apt-get install -y -qq \
    bash coreutils findutils grep sed gawk \
    git git-lfs curl wget jq rsync tmux \
    build-essential cmake pkg-config unzip \
    ca-certificates \
    python3 python3-dev python3-venv gh
fi

git lfs install --skip-repo
```

Verify:

```bash
for name in bash git git-lfs curl wget jq rsync tmux cmake python3 gh; do
  command -v "$name" >/dev/null || { printf 'MISSING: %s\n' "$name"; exit 1; }
done

bash --version | sed -n '1p'
git --version
git lfs version
jq --version
python3 --version
```

**Gate 1:** all required utilities are available and Git LFS works.

---

## 5. Install Node.js and Pi

Pi is the replacement for OpenCode in this workflow. Use the official Pi coding-agent package.

Node 22 is the target runtime:

```bash
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
. "$NVM_DIR/nvm.sh"
nvm install 22
nvm alias default 22
nvm use 22

node --version
npm --version
```

The Node major version must be 22. If `nvm` is not installed, install it using the provider's approved machine bootstrap method, open a new SSH shell, and rerun this gate. Do not proceed with an unsupported Node version.

Install Pi:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
pi --help >/tmp/pi-help.txt
```

Install the package from the GitHub source checkout:

```bash
cd "$HOME"
if [ ! -d pi-shell-specialization/.git ]; then
  git clone "$CODE_REPO" pi-shell-specialization
fi
cd "$HOME/pi-shell-specialization"
git fetch origin
git checkout main
git pull --ff-only origin main
npm ci
npm test
npm run build
```

The package must be loaded by Pi:

```bash
cd "$HOME/pi-shell-specialization"
pi -e ./src/index.ts --help >/tmp/pi-shell-specialization-help.txt 2>&1 || true
pi list
```

If the package is installed through Pi's package manager instead of direct `-e` loading:

```bash
pi install git:github.com/rajivmehtaflex/pi-shell-specialization
```

**Gate 2:** Node 22, `pi --version`, package build, package tests, and Pi package discovery pass.

---

## 6. Install Python/TRL/OpenEnv environments

The article's runnable TRL example declares these relevant dependencies:

```text
trl
trackio
datasets
huggingface_hub
openenv
```

For Pi, do **not** install `openenv-opencode-env`. That is OpenCode-specific. Install OpenEnv core and add a project-owned Pi adapter later.

Create isolated environments:

```bash
cd "$HOME/pi-shell-specialization"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv python install 3.12
uv venv .venv-control --python 3.12
uv venv .venv-rl --python 3.12
uv venv .venv-vllm --python 3.12
```

Control environment:

```bash
uv pip install --python .venv-control/bin/python \
  huggingface_hub datasets accelerate \
  gitpython
```

Training/OpenEnv environment:

```bash
uv pip install --python .venv-rl/bin/python \
  torch transformers trl trackio datasets \
  peft bitsandbytes accelerate sentencepiece protobuf \
  huggingface_hub

uv pip install --python .venv-rl/bin/python \
  "openenv @ git+https://github.com/huggingface/OpenEnv.git"
```

If the installed TRL release does not expose the harness API, install the current TRL source and rerun the import gate:

```bash
.venv-rl/bin/python - <<'PY'
try:
    from trl.experimental.async_grpo import AsyncGRPOConfig, AsyncGRPOTrainer
    from trl.experimental.async_grpo.openenv_harness import HarnessRolloutWorker, has_tool_call
    print("TRL harness API: PASS")
except Exception as error:
    print(f"TRL harness API: FAIL: {error}")
    raise SystemExit(1)
PY
```

Serving environment:

```bash
uv pip install --python .venv-vllm/bin/python \
  torch transformers vllm huggingface_hub sentencepiece protobuf
```

Verify all environments:

```bash
.venv-control/bin/python - <<'PY'
import datasets, huggingface_hub
print("control datasets", datasets.__version__)
print("control huggingface_hub", huggingface_hub.__version__)
PY

.venv-rl/bin/python - <<'PY'
import torch, transformers, trl, datasets, trackio, openenv
from trl.experimental.async_grpo import AsyncGRPOConfig, AsyncGRPOTrainer
from trl.experimental.async_grpo.openenv_harness import HarnessRolloutWorker, has_tool_call
print("rl torch", torch.__version__, "cuda", torch.cuda.is_available())
print("rl transformers", transformers.__version__)
print("rl trl", trl.__version__)
print("openenv", openenv.__file__)
print("harness API: PASS")
PY

.venv-vllm/bin/python - <<'PY'
import torch, vllm
print("vllm torch", torch.__version__, "cuda", torch.cuda.is_available())
print("vllm", vllm.__version__)
PY
```

**Gate 3:** the TRL harness API, OpenEnv, Trackio, CUDA training stack, and vLLM import successfully.

---

## 7. Authenticate GitHub and Hugging Face

Use the intended accounts:

```text
GitHub: rajivmehtaflex
Hugging Face: rajivmehtapy
```

GitHub:

```bash
gh auth status
```

Hugging Face:

```bash
.venv-control/bin/hf auth login --token "$HF_TOKEN" --add-to-git-credential
.venv-control/bin/hf auth whoami
```

Clone the durable HF repository separately:

```bash
cd "$HOME"
if [ ! -d pi-shell-specialization-state/.git ]; then
  git clone https://huggingface.co/rajivmehtapy/pi-shell-specialization pi-shell-specialization-state
fi
cd "$HOME/pi-shell-specialization-state"
git lfs install
git checkout main
git pull --ff-only origin main
```

Verify without exposing credentials:

```bash
git -C "$HOME/pi-shell-specialization" ls-remote origin HEAD
git -C "$HOME/pi-shell-specialization-state" ls-remote origin HEAD
git -C "$HOME/pi-shell-specialization-state" remote -v
```

**Gate 4:** GitHub code access, HF identity, HF Git-LFS access, and both repository checkouts pass. No token may appear in `git remote -v`.

---

## 8. Model and endpoint configuration

This project has two distinct model roles.

### 8.1 Offline teacher-data role

The 27B teacher is used to generate reference answers and targeted data before student training. It is not a live GRPO co-pilot.

The teacher can be served by llama.cpp:

```text
TEACHER_BASE_URL=<llama.cpp OpenAI-compatible endpoint>/v1
TEACHER_MODEL=<served teacher model name>
```

If the SSH machine launches the teacher locally, record the exact GGUF repository, filename, quantization, and SHA-256. Do not guess a GGUF filename.

### 8.2 Student policy role

The student is the trainable model used for:

```text
SFT
base/student evaluation
GRPO policy rollouts
final serving
```

Verify the student checkpoint:

```bash
: "${STUDENT_MODEL_ID:?STUDENT_MODEL_ID is required}"
.venv-control/bin/hf download "$STUDENT_MODEL_ID" \
  --include 'config.json' \
  --include 'tokenizer*' \
  --local-dir "$HOME/models/student"
```

A GGUF student file is not sufficient for SFT. The training path requires a trainable Transformers checkpoint.

### 8.3 Policy vLLM smoke configuration

The article's transparent-proxy/AsyncGRPO path requires vLLM to support:

```text
tool calling
processed logprobs
token IDs in responses
OpenAI-compatible chat completions
```

A model-compatible command is structurally similar to:

```bash
CUDA_VISIBLE_DEVICES=0 .venv-vllm/bin/vllm serve "$STUDENT_MODEL_ID" \
  --host 127.0.0.1 \
  --port 8000 \
  --enable-auto-tool-choice \
  --tool-call-parser "$VLLM_TOOL_CALL_PARSER" \
  --logprobs-mode processed_logprobs \
  --return-tokens-as-token-ids
```

For the exact two-GPU AsyncGRPO design, add the model-compatible NCCL weight-transfer configuration documented by the installed TRL/vLLM version. Do not copy the article's `hermes` parser blindly; select the parser supported by the actual student model's chat/tool format.

Run a simple `/v1/models` and chat-completion smoke test before using Pi.

**Gate 5:** exact teacher/student model IDs or files are recorded, the student is trainable, and the policy endpoint can return a tool-capable OpenAI-compatible response.

---

## 9. Pi/OpenEnv adapter requirements

This is the main replacement work for OpenCode.

The package must add a Python adapter, for example:

```text
remote/pi_env/
  __init__.py
  config.py
  task.py
  harness.py
  runtime.py
  sandbox/base.py
  sandbox/local.py
  interception.py
  verifier.py
```

Required behavior:

1. Start Pi noninteractively in a rollout workspace.
2. Load `pi-shell-specialization` as an extension.
3. Configure Pi to use the OpenAI-compatible proxy URL.
4. Run Pi's real tool loop, not a reimplemented trainer loop.
5. Create one isolated workspace per rollout.
6. Capture each Pi model request and response through a transparent proxy.
7. Record token IDs/logprobs when the selected vLLM/TRL path supports them.
8. Filter auxiliary Pi calls from training turns.
9. Run the hidden shell verifier after Pi exits.
10. Return a typed rollout outcome to `HarnessRolloutWorker`.

The first adapter should use a local subprocess sandbox on the SSH machine:

```text
one rollout = one temporary directory + one Pi process + one proxy
```

A remote sandbox backend can be added later. It is not required for the first SSH-machine smoke test.

**Gate 6:** one Pi rollout can run in an isolated directory, call the configured OpenAI-compatible endpoint, produce a trace, and return a verifier result. Do not begin AsyncGRPO until this gate passes.

### Pi phase-command contract

When Pi controls the SSH machine from another host, the extension reads non-secret phase commands from:

```text
state/phase-commands.json
```

Example shape:

```json
{
  "P0": {
    "command": "bash scripts/phases/p0-baseline.sh",
    "gpu": "L4",
    "timeoutSeconds": 3600,
    "estimatedCostUsd": 1
  },
  "P2.6": {
    "command": "bash scripts/phases/p2-6-async-grpo.sh",
    "gpu": "L4:2",
    "timeoutSeconds": 28800,
    "estimatedCostUsd": 8,
    "estimatedGpuSeconds": 28800
  }
}
```

The package launches only commands present in this allowlisted file. Missing phase commands are reported as `blocked`; they are never guessed or generated from model output. P2.6 must declare the two-GPU topology explicitly.

---

## 10. SFT/GRPO policy

### SFT

Recommended first pass:

```text
method: QLoRA
student: trainable Qwen checkpoint
epochs: 3
sequence length: 2048
assistant-only loss: enabled
gradient checkpointing: enabled
```

Teacher responses are generated offline, verified, deduplicated, and split before SFT.

### Loop-owning AsyncGRPO

The article's training path uses:

```text
HarnessRolloutWorker
harness_adapter=None
AsyncGRPOTrainer
transparent_proxy traces
hidden verifier reward
```

For this shell project:

```text
rollout_reward_fn: shell verifier result plus bounded safety/timeout penalties
train_turn_fn: retain Pi action/tool turns
agent_turn_fn: filter Pi auxiliary/non-agent calls
teacher assistance during rollout: disabled
```

The first GRPO run must be a smoke run:

```text
small prompt count
small number of steps
nonzero reward_std
artifacts/checkpoint saved
reward report written
```

Do not claim the article's two-GPU AsyncGRPO path is operational on a one-GPU machine. If only one GPU is available, use black-box evaluation/sequential SFT first and explicitly decide whether to implement a one-GPU/offline-rollout GRPO variant.

**Gate 7:** SFT/GRPO configuration is recorded in the phase ledger and the selected GPU topology supports the selected training mode.

---

## 11. Phase and persistence blockers

Environment installation does not complete these package tasks:

| Blocker | Required work | Gate |
|---|---|---|
| Central orchestrator | Connect ledger, adapters, deterministic workers, gates, and checkpoints | Full dry-run completes |
| Pi/OpenEnv harness | Replace OpenCode-specific session factory with Pi adapter | One Pi rollout trace/verifier pass |
| Phase tools | Register `shell_specialization_*` tools in `src/index.ts` | Pi discovers status/start/resume tools |
| Dashboard | Render status/cursor/job/cost/commit/artifact table | Live Pi TUI displays ledger |
| Resume bootstrap | Pull repos, verify hashes, recover stale phases, poll jobs | New SSH machine resumes correctly |
| HF checkpoint sync | Push before launch, after job registration, after batches, after completion | Durable commit exists each time |
| Training workers | Add SFT, merge, eval, AsyncGRPO, and serving entry points | Remote job specs execute |
| First external smoke | One Linux/Pi rollout with hidden verification | Artifact and state checkpoint pushed |

The package foundation already includes the benchmark, weakness analysis, ledger foundation, question generator, teacher client, verifier, data audit, and fake remote jobs. The items above are the remaining integration and remote-execution work.

---

## 12. Dry-run and live gates

### 12.1 Local package dry-run

```text
model calls: 0
network calls: 0
GPU jobs: 0
remote pushes: 0
one simple prompt simulated
all phase records written with simulation=true
```

### 12.2 SSH-machine Pi harness smoke

```text
one Pi process
one isolated local sandbox
one policy endpoint
one captured trace
one hidden shell verification
no training update
```

### 12.3 First live data phase

Only after the previous gates pass:

```text
one weakness-conditioned prompt
one teacher answer
one verified example
one artifact-manifest update
one phase-ledger update
one remote checkpoint push
```

### 12.4 Full training

Only after the first live data phase passes:

```text
P0 baseline
P2.0 question generation
P2.1 teacher data
P2.2 audit/split
P2.3 SFT
P2.5 base/student evaluation
P2.6 optional loop-owning AsyncGRPO
P2.7 serving
P2.8 Pi provider/final export
```

---

## 13. Ollama policy

Ollama is **not part of this workflow**.

```text
No Ollama on this Mac.
No Ollama on the SSH GPU machine.
No Ollama fallback in the teacher client.
No Ollama-generated training or evaluation results.
```

Use:

```text
llama.cpp: offline 27B teacher inference
vLLM: student policy serving for tool calls/logprobs/GRPO
Transformers/TRL: student SFT and AsyncGRPO
Pi: loop-owning coding-agent harness
OpenEnv: sandbox/session/trace integration
```

The existing repository `src/ollama.ts` is a legacy diagnostic adapter and is not used by this workflow.

---

## 14. Phase 1 exit report

Report non-secret values only:

```text
PHASE 1 RESULT
- SSH host/workdir: <non-secret>                 [PASS/FAIL]
- Linux/Bash/GNU: <versions>                     [PASS/FAIL]
- GPU topology: <count/model/VRAM>               [PASS/FAIL]
- CPU/RAM/disk: <values>                         [PASS/FAIL]
- Node/Pi: <versions>                            [PASS/FAIL]
- Package tests/build: <result>                  [PASS/FAIL]
- TRL harness API: <version/import>              [PASS/FAIL]
- OpenEnv core: <version/import>                 [PASS/FAIL]
- vLLM: <version/import>                         [PASS/FAIL]
- GitHub repo: rajivmehtaflex/pi-shell-specialization [PASS/FAIL]
- HF artifact repo: rajivmehtapy/pi-shell-specialization [PASS/FAIL]
- HF identity: <username only>                   [PASS/FAIL]
- Student model ID/revision: <non-secret>        [PASS/FAIL]
- Teacher model/endpoint: <non-secret>           [PASS/FAIL]
- Pi harness adapter: <implemented/not yet>      [PASS/FAIL]
- Ollama: excluded                               [PASS]
- Package dry-run: <checkpoint>                  [PASS/FAIL]
- Pi one-rollout smoke: <checkpoint>             [PASS/FAIL]

Next: finish the Pi/OpenEnv harness adapter, central orchestrator,
phase tools, dashboard, resume bootstrap, and first live shell rollout.
```

---

## 15. Source notes from the Hugging Face article

The article's reusable principles are:

1. The harness owns the agent loop; the trainer does not reimplement it.
2. A transparent proxy captures real model calls and token IDs/logprobs.
3. Each rollout gets an isolated sandbox.
4. Hidden verification supplies the reward.
5. `HarnessRolloutWorker` and `AsyncGRPOTrainer` train on the captured agent turns.
6. Tool/action turns should be selected separately from auxiliary calls.
7. Remote sandboxes need a vLLM URL reachable from outside the training node.
8. Rollout failures and leaked sandboxes need explicit cleanup and retry handling.
9. The exact article example uses two GPUs for vLLM plus training; hardware topology must be checked before launch.

This workflow keeps those principles but substitutes Pi for OpenCode and uses the SSH machine as the primary execution host.
