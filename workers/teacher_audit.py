from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from workers.contracts import compute_record_hash


def audit(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen: set[str] = set()
    seen_content: set[str] = set()
    for row in rows:
        task = row.get("task", row)
        task_id = str(row.get("task_id", task.get("id", "") if isinstance(task, dict) else ""))
        content_hash = compute_record_hash(row)
        reason = None
        if not task_id:
            reason = "missing task id"
        elif task_id in seen:
            reason = "duplicate task id"
        elif row.get("verification") not in {"passed", True}:
            reason = "teacher answer not verified"
        elif isinstance(task, dict) and task.get("verifierSpec") and task.get("verifierSpec") in str(task.get("prompt", "")):
            reason = "verifier leaked into public prompt"
        elif not isinstance(row.get("response"), str) or not row.get("response", "").strip():
            reason = "missing or empty response"
        elif not isinstance(task, dict) or not str(task.get("prompt", "")).strip():
            reason = "missing task content"
        elif content_hash in seen_content:
            reason = "duplicate canonical content"
        if reason:
            rejected.append({"task_id": task_id, "reason": reason})
        else:
            seen.add(task_id)
            seen_content.add(content_hash)
            accepted.append(row)
    report = {"input": len(rows), "accepted": len(accepted), "rejected": len(rejected), "rejections": rejected}
    return accepted, report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input_path", required=True)
    parser.add_argument("--out", dest="output_path", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in Path(args.input_path).read_text(encoding="utf-8").splitlines() if line.strip()]
    accepted, report = audit(rows)
    Path(args.output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output_path).write_text("\n".join(json.dumps(row, sort_keys=True) for row in accepted) + ("\n" if accepted else ""), encoding="utf-8")
    Path(args.report).write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0 if report["rejected"] == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
