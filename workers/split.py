"""Deterministic dataset splitting under the production quota gate.

Split result contract (consumed by the TS orchestrator data phase, see
``src/orchestrator/data-phase.ts``): the result is a dict with exactly

    {"train": [rows], "eval": [rows], "holdout": [rows], "balanceDelta": <float 0..1>}

Quotas are fixed to the production gate: eval = 250, holdout = 250, and train
takes the remainder, so the input must contain at least 2300 accepted rows
(counted AFTER defensive content dedup: rows with identical canonical content
keep only their first occurrence).

Ordering is fully deterministic. Every row gets a canonical identity hash --
its own ``content_hash`` field when present, else ``compute_record_hash`` of
the envelope, else a salted sha256 of the task id (never a bare missing-id
fallback, which would clump all unnamed rows onto one hash) -- and rows are
ordered by sha256 of ``<seed>:<identity>``.

``eval`` and ``holdout`` are allocated per category (``task.category``,
falling back to the row-level ``category`` and then ``"unknown"``) with the
largest-remainder method, so both gated splits mirror the input's category
distribution. ``balanceDelta`` is the worst absolute share deviation
``|share in split - share overall|`` over all categories, reported as the
maximum across the eval and holdout splits (the TS gate requires <= 0.1).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

from workers.contracts import compute_record_hash

EVAL_COUNT = 250
HOLDOUT_COUNT = 250
TRAIN_MINIMUM = 1800


def _row_identity(row: dict[str, Any]) -> str:
    """Canonical identity used for dedup and deterministic ordering."""
    identity = row.get("content_hash")
    if isinstance(identity, str) and identity.strip():
        return identity
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    prompt = str(task.get("prompt", ""))
    response = str(row.get("response", ""))
    if prompt.strip() or response.strip():
        return compute_record_hash(row)
    task_id = row.get("task_id", task.get("id"))
    if task_id:
        return hashlib.sha256(f"id:{task_id}".encode("utf-8")).hexdigest()
    raise ValueError("row has no content_hash, task content, or task_id; cannot identify it for splitting")


def _row_category(row: dict[str, Any]) -> str:
    task = row.get("task") if isinstance(row.get("task"), dict) else {}
    for source in (task.get("category"), row.get("category")):
        if isinstance(source, str) and source.strip():
            return source
    return "unknown"


def _largest_remainder(sizes: dict[str, int], quota: int) -> dict[str, int]:
    """Apportion ``quota`` across categories proportionally to their sizes.

    Ties on the fractional remainder break by category name, keeping the
    allocation deterministic for a given input.
    """
    total = sum(sizes.values())
    if total == 0 or quota <= 0:
        return {category: 0 for category in sizes}
    shares = {category: quota * size / total for category, size in sizes.items()}
    quotas = {category: math.floor(share) for category, share in shares.items()}
    leftover = quota - sum(quotas.values())
    by_remainder = sorted(sizes, key=lambda category: (-(shares[category] - quotas[category]), category))
    for category in by_remainder[:leftover]:
        quotas[category] += 1
    return quotas


def split_rows(
    rows: list[dict[str, Any]],
    seed: int = 42,
    eval_count: int = EVAL_COUNT,
    holdout_count: int = HOLDOUT_COUNT,
    train_minimum: int = TRAIN_MINIMUM,
) -> dict[str, Any]:
    """Split accepted rows into train/eval/holdout with a balance report."""
    identities: list[str] = []
    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        identity = _row_identity(row)
        if identity in seen:
            continue
        seen.add(identity)
        identities.append(identity)
        deduped.append(row)

    minimum = train_minimum + eval_count + holdout_count
    if len(deduped) < minimum:
        raise ValueError(f"input must contain at least {minimum} accepted rows")

    order = sorted(
        range(len(deduped)),
        key=lambda index: hashlib.sha256(f"{seed}:{identities[index]}".encode("utf-8")).hexdigest(),
    )
    ordered = [deduped[index] for index in order]

    by_category: dict[str, list[dict[str, Any]]] = {}
    for row in ordered:
        by_category.setdefault(_row_category(row), []).append(row)
    sizes = {category: len(members) for category, members in by_category.items()}

    eval_quotas = _largest_remainder(sizes, eval_count)
    remaining_sizes = {category: sizes[category] - eval_quotas[category] for category in sizes}
    holdout_quotas = _largest_remainder(remaining_sizes, holdout_count)

    train: list[dict[str, Any]] = []
    eval_split: list[dict[str, Any]] = []
    holdout: list[dict[str, Any]] = []
    for category in sorted(by_category):
        members = by_category[category]
        eval_take = eval_quotas[category]
        holdout_take = min(holdout_quotas[category], len(members) - eval_take)
        eval_split.extend(members[:eval_take])
        holdout.extend(members[eval_take : eval_take + holdout_take])
        train.extend(members[eval_take + holdout_take :])

    # Defensive: the quotas always fit by construction (quota < remaining
    # total per split), but guarantee the exact production counts regardless.
    for gated, quota in ((eval_split, eval_count), (holdout, holdout_count)):
        while len(gated) < quota and train:
            gated.append(train.pop(0))

    total = len(deduped)
    delta = 0.0
    for gated in (eval_split, holdout):
        if not gated:
            continue
        counts = Counter(_row_category(row) for row in gated)
        for category, size in sizes.items():
            delta = max(delta, abs(counts.get(category, 0) / len(gated) - size / total))

    return {"train": train, "eval": eval_split, "holdout": holdout, "balanceDelta": round(delta, 6)}


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
    parser.add_argument("--eval-count", type=int, default=EVAL_COUNT)
    parser.add_argument("--holdout-count", type=int, default=HOLDOUT_COUNT)
    args = parser.parse_args()
    rows = [json.loads(line) for line in Path(args.input_path).read_text(encoding="utf-8").splitlines() if line.strip()]
    split = split_rows(rows, seed=args.seed, eval_count=args.eval_count, holdout_count=args.holdout_count)
    write_rows(args.train, split["train"])
    write_rows(args.eval, split["eval"])
    write_rows(args.holdout, split["holdout"])
    print(
        json.dumps(
            {
                "train": len(split["train"]),
                "eval": len(split["eval"]),
                "holdout": len(split["holdout"]),
                "balanceDelta": split["balanceDelta"],
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
