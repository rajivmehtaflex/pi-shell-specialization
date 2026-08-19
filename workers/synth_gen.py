from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def synthesize(row: dict[str, Any]) -> dict[str, Any]:
    task = row.get("task", row)
    task_id = str(task.get("id", row.get("id", "unknown")))
    seed = hashlib.sha256(task_id.encode("utf-8")).hexdigest()[:16]
    return {
        "synth_id": f"synth-{task_id}",
        "task_id": task_id,
        "scenario_seed": seed,
        "dialect": task.get("dialect", "linux-bash5-gnu"),
        "task": task,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input_path", required=True)
    parser.add_argument("--out", dest="output_path", required=True)
    args = parser.parse_args()
    rows = []
    for line in Path(args.input_path).read_text(encoding="utf-8").splitlines():
        if line.strip():
            rows.append(synthesize(json.loads(line)))
    Path(args.output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output_path).write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + ("\n" if rows else ""), encoding="utf-8")
    print(json.dumps({"rows": len(rows), "output": args.output_path}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
