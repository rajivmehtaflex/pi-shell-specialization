from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def split_rows(rows: list[dict[str, Any]], seed: int = 42, holdout_count: int = 250, train_ratio: float = 0.7) -> dict[str, list[dict[str, Any]]]:
    if len(rows) <= holdout_count:
        raise ValueError("input must contain more rows than holdout_count")
    ordered = sorted(rows, key=lambda row: hashlib.sha256(f"{seed}:{row.get('task_id', row.get('id', ''))}".encode()).hexdigest())
    holdout = ordered[-holdout_count:]
    remaining = ordered[:-holdout_count]
    train_count = round(len(remaining) * train_ratio)
    return {"train": remaining[:train_count], "eval": remaining[train_count:], "holdout": holdout}


def write_rows(path: str, rows: list[dict[str, Any]]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + ("\n" if rows else ""), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in", dest="input_path", required=True)
    parser.add_argument("--train", required=True)
    parser.add_argument("--eval", required=True)
    parser.add_argument("--holdout", required=True)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--holdout-count", type=int, default=250)
    args = parser.parse_args()
    rows = [json.loads(line) for line in Path(args.input_path).read_text(encoding="utf-8").splitlines() if line.strip()]
    split = split_rows(rows, seed=args.seed, holdout_count=args.holdout_count)
    write_rows(args.train, split["train"])
    write_rows(args.eval, split["eval"])
    write_rows(args.holdout, split["holdout"])
    print(json.dumps({key: len(value) for key, value in split.items()}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
