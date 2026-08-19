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
