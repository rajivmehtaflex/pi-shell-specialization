# Question artifacts

`src/cases.ts` is the canonical question/fixture source.

## Public question files

- `shell-questions-60-public.md` — safe model-facing Markdown list
- `shell-questions-60.json` — safe machine-readable list

These contain the question prompt, category, difficulty, ID, and sequence only. They must not contain fixture setup, verifier commands, expected outputs, or failure labels.

## Evaluator-only file

- `shell-questions-60-private.json` — includes fixtures, hidden verification, score weights, and failure labels

Keep this file out of the model context. Use it only inside a disposable external evaluator that executes generated scripts under the target shell dialect.

## Administration

Ask each question independently in a fresh model context. Require exactly one `bash` fenced block and no explanation. Record the raw response, model, track, attempt number, decoding settings, and external execution result. One attempt provides a baseline; three attempts support pass@1/pass@3 analysis.
