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

During development and local testing, explicitly tell Pi not to invoke Ollama or run model-generated scripts on the Mac. Real evaluation belongs in the external Linux sandbox/Modal workflow.

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
npm test
npm run build
node dist/src/cli.js validate
```

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

- `shell_benchmark_cases` — legacy metadata tool
- `shell_benchmark_question_list` — filtered public questions
- `shell_benchmark_start` — controlled diagnostic session
- `shell_benchmark_next` — next public question
- `shell_benchmark_record_response` — record a response without executing it
- `shell_benchmark_import_results` — validate external JSONL
- `shell_benchmark_weakness_report` — generate a weakness report from external results

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
