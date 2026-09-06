# External result schema

The external evaluator submits one JSON object per line. The analysis package validates every record before importing it and never executes the `response` field during import/report.

```json
{
  "session_id": "shell-2026-08-19-a1b2c3",
  "model": "qwen3.5:9b",
  "provider": "external",
  "track": "raw",
  "case_id": "quote-004",
  "attempt": 1,
  "response": "```bash\n...\n```",
  "execution": {
    "status": "failed",
    "syntax": "passed",
    "verification": "failed",
    "exitCode": 0,
    "stdout": "",
    "stderr": "",
    "durationMs": 37,
    "findings": [],
    "error": "fixture verification failed"
  },
  "runner": {
    "shell": "/bin/bash",
    "shellVersion": "3.2",
    "sandbox": "external-disposable-vm",
    "temperature": 0,
    "seed": 42
  }
}
```

## Required rules

- `case_id` must be one of the 60 benchmark IDs.
- `(session_id, track, case_id, attempt)` must be unique.
- `track` must be `raw` or `pi-tools`.
- `execution.status` must be `passed`, `failed`, `timed-out`, `sandbox-unavailable`, or `blocked`.
- `execution.syntax` must be `passed`, `failed`, or `not-run`.
- `execution.verification` must be `passed`, `failed`, or `not-run`.
- The external runner must record the shell dialect and sandbox identity.
- Keep private fixtures and verifiers out of the model prompt.

## Failure interpretation

- Output-format/refusal failures are protocol evidence.
- Sandbox/fixture/verifier failures are evaluator evidence.
- Repeated machine-verified task failures are capability evidence and may drive teacher-data generation.

---

## Teacher verified-data envelope (workers pipeline)

The workers pipeline emits verified teacher records. The canonical contract is defined in `workers/contracts.py` (Python) and mirrored by `src/diagnostic-types.ts` (`TeacherRecord`, `validateTeacherRecord`); both languages validate the same shape and compute identical `content_hash` values.

```json
{
  "task_id": "quote-004",
  "task": { "prompt": "List files in /tmp" },
  "response": "```bash\nls /tmp\n```",
  "verification": "passed",
  "execution": { "status": "passed", "exitCode": 0, "durationMs": 12 },
  "failureLabels": [],
  "provenance": {
    "session_id": "teacher-2026-09-06-a1b2c3",
    "model": "qwen3.5:9b",
    "provider": "pi",
    "track": "pi-tools",
    "attempt": 2
  },
  "content_hash": "948a41ef29de3b185c57990fdc6bf3588d2d1308b9aba94f8cdc4fe137b926d3"
}
```

### Field reference

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `task_id` | string | yes | non-empty; same benchmark case ID values as `case_id` (see mapping below) |
| `task` | object | yes | must contain `task.prompt` (non-empty string); extra keys allowed |
| `response` | string | yes | non-empty after trim |
| `verification` | string | yes | `passed` or `failed` |
| `execution` | object | yes | free-form execution metadata object |
| `failureLabels` | string[] | yes | array of strings, may be empty |
| `provenance` | object | yes | teacher-run provenance, see below |
| `provenance.session_id` | string | yes | non-empty |
| `provenance.model` | string | yes | non-empty |
| `provenance.provider` | string | yes | non-empty |
| `provenance.track` | string | yes | `raw` or `pi-tools` |
| `provenance.attempt` | integer | yes | >= 1 |
| `content_hash` | string | yes | 64 lowercase hex chars; sha256 of the canonical normalized payload |

### Identifier mapping

The teacher pipeline uses `task_id`, while external benchmark attempt records use `case_id`. Both fields carry the same benchmark case ID values; a teacher record and an attempt record referencing the same benchmark case will hold equal strings in these fields.

### content_hash canonical payload

1. Normalize both the task prompt and the response: collapse every whitespace run to a single space, then trim (`normalizeTeacherText`).
2. Build the JSON payload with sorted keys, `", "` / `": "` separators, and non-ASCII kept as raw UTF-8 (matches Python `json.dumps(obj, sort_keys=True, ensure_ascii=False)`):
   `{"response": <normalized response>, "task": <normalized task prompt>}`
3. `content_hash` is the sha256 hex digest of the payload's UTF-8 bytes (`teacherContentHash`).

Pinned cross-language test vector (validated in both Python and TypeScript test suites):

- task input: `"List files in /tmp\n"` — normalized: `"List files in /tmp"`
- response input: "```bash\nls /tmp\n```\n" — normalized: "```bash ls /tmp ```"
- payload bytes: `{"response": "```bash ls /tmp ```", "task": "List files in /tmp"}`
- expected sha256 hex: `948a41ef29de3b185c57990fdc6bf3588d2d1308b9aba94f8cdc4fe137b926d3`
