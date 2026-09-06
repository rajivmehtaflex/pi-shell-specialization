import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from workers.contracts import compute_record_hash, validate_envelope
from workers.teacher_audit import audit
from workers.verify import verify_response
from workers.split import split_rows


def envelope_row(task_id, prompt, response, verification="passed"):
    return {
        "task_id": task_id,
        "task": {"id": task_id, "prompt": prompt},
        "response": response,
        "verification": verification,
    }


class DataPhaseTests(unittest.TestCase):
    def test_audit_accepts_verified_unique_rows(self):
        rows = [envelope_row("a", "copy the file", "```bash\ncp a b\n```")]
        accepted, report = audit(rows)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(report["rejected"], 0)

    def test_audit_rejects_duplicates_and_unverified(self):
        rows = [
            envelope_row("a", "copy the file", "```bash\ncp a b\n```"),
            envelope_row("a", "copy the file", "```bash\ncp a b\n```"),
            envelope_row("b", "bad task", "```bash\ntrue\n```", verification="failed"),
        ]
        accepted, report = audit(rows)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(report["rejected"], 2)
        reasons = {entry["task_id"]: entry["reason"] for entry in report["rejections"]}
        self.assertEqual(reasons["a"], "duplicate task id")
        self.assertEqual(reasons["b"], "teacher answer not verified")

    def test_audit_rejects_missing_or_empty_response(self):
        rows = [
            envelope_row("a", "copy the file", ""),
            {"task_id": "b", "verification": "passed", "task": {"id": "b", "prompt": "copy"}},
            envelope_row("c", "copy the file", "   \n\t"),
        ]
        accepted, report = audit(rows)
        self.assertEqual(accepted, [])
        self.assertEqual(report["rejected"], 3)
        self.assertEqual({entry["reason"] for entry in report["rejections"]}, {"missing or empty response"})

    def test_audit_rejects_missing_task_content(self):
        rows = [
            {"task_id": "a", "verification": "passed", "response": "```bash\ntrue\n```", "task": {"id": "a"}},
            {"task_id": "b", "verification": "passed", "response": "```bash\ntrue\n```", "task": {"id": "b", "prompt": "   "}},
            {"task_id": "c", "verification": "passed", "response": "```bash\ntrue\n```", "task": None},
        ]
        accepted, report = audit(rows)
        self.assertEqual(accepted, [])
        self.assertEqual({entry["reason"] for entry in report["rejections"]}, {"missing task content"})

    def test_audit_rejects_duplicate_canonical_content_across_task_ids(self):
        shared_prompt = "copy the file 'a.txt' to 'b.txt'"
        shared_response = "```bash\ncp a.txt b.txt\n```"
        rows = [
            envelope_row("task-1", shared_prompt, shared_response),
            envelope_row("task-2", shared_prompt, shared_response),
        ]
        self.assertEqual(compute_record_hash(rows[0]), compute_record_hash(rows[1]))
        accepted, report = audit(rows)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]["task_id"], "task-1")
        self.assertEqual(report["rejected"], 1)
        self.assertEqual(report["rejections"][0]["reason"], "duplicate canonical content")
        self.assertEqual(report["rejections"][0]["task_id"], "task-2")

    def test_audit_accepts_same_task_id_shape_but_distinct_content(self):
        rows = [
            envelope_row("task-1", "prompt one", "```bash\necho one\n```"),
            envelope_row("task-2", "prompt two", "```bash\necho two\n```"),
        ]
        accepted, report = audit(rows)
        self.assertEqual(len(accepted), 2)
        self.assertEqual(report["rejected"], 0)

    def test_verify_output_passes_directly_into_audit(self):
        task = {
            "id": "int-copy",
            "prompt": "Copy the file named 'hello world.txt' to 'copied.txt' keeping its contents.",
            "setupFiles": {"hello world.txt": "hello shell\n"},
            "environment": {"INPUT_FILE": "hello world.txt"},
            "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
        }
        envelope = verify_response(task, '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```')
        self.assertEqual(validate_envelope(envelope), [])
        accepted, report = audit([envelope])
        self.assertEqual(len(accepted), 1)
        self.assertIs(accepted[0], envelope)
        self.assertEqual(report["rejected"], 0)

def split_input_rows(count, categories=("ops", "git", "text", "files", "search")):
    """Build verified-envelope-shaped rows with distinct content and categories."""
    rows = []
    for index in range(count):
        category = categories[index % len(categories)]
        prompt = f"task {index}: run `echo {index}` and keep the output."
        response = f"```bash\necho {index}\n```"
        rows.append(
            {
                "task_id": f"task-{index:05d}",
                "task": {"id": f"task-{index:05d}", "prompt": prompt, "category": category},
                "response": response,
                "verification": "passed",
            }
        )
    return rows


class SplitQuotaTests(unittest.TestCase):
    """T4.1: production quotas, dedup, balance, and determinism."""

    def test_split_meets_production_quotas_with_balance(self):
        result = split_rows(split_input_rows(2300))
        self.assertEqual(len(result["train"]), 1800)
        self.assertEqual(len(result["eval"]), 250)
        self.assertEqual(len(result["holdout"]), 250)
        self.assertIsInstance(result["balanceDelta"], float)
        self.assertGreaterEqual(result["balanceDelta"], 0.0)
        self.assertLessEqual(result["balanceDelta"], 0.1)

    def test_split_rejects_below_minimum_before_writing(self):
        rows = split_input_rows(2299)
        with tempfile.TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "input.jsonl"
            input_path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            train_path = Path(tmp) / "train.jsonl"
            eval_path = Path(tmp) / "eval.jsonl"
            holdout_path = Path(tmp) / "holdout.jsonl"
            argv = [
                "split.py",
                "--in", str(input_path),
                "--train", str(train_path),
                "--eval", str(eval_path),
                "--holdout", str(holdout_path),
            ]
            from workers.split import main

            with mock.patch("sys.argv", argv):
                with self.assertRaises(ValueError) as ctx:
                    main()
            self.assertIn("input must contain at least 2300 accepted rows", str(ctx.exception))
            for path in (train_path, eval_path, holdout_path):
                self.assertFalse(path.exists(), f"{path.name} must not be written on rejection")

    def test_split_dedups_identical_content_across_task_ids(self):
        rows = split_input_rows(2301)
        rows[1]["task"]["prompt"] = rows[0]["task"]["prompt"]
        rows[1]["response"] = rows[0]["response"]
        self.assertEqual(compute_record_hash(rows[0]), compute_record_hash(rows[1]))
        result = split_rows(rows)
        self.assertEqual((len(result["train"]), len(result["eval"]), len(result["holdout"])), (1800, 250, 250))
        all_ids = [row["task_id"] for part in ("train", "eval", "holdout") for row in result[part]]
        self.assertEqual(len(all_ids), 2300)
        self.assertNotIn("task-00001", all_ids)  # duplicate content dropped, first kept

    def test_split_counts_minimum_after_dedup(self):
        rows = split_input_rows(2300)
        rows[1]["task"]["prompt"] = rows[0]["task"]["prompt"]
        rows[1]["response"] = rows[0]["response"]
        with self.assertRaises(ValueError):
            split_rows(rows)

    def test_split_is_deterministic_byte_for_byte(self):
        rows = split_input_rows(2300)
        first = json.dumps(split_rows(rows), sort_keys=True)
        second = json.dumps(split_rows(rows), sort_keys=True)
        self.assertEqual(first, second)

    def test_split_parts_are_disjoint_by_id_and_content(self):
        rows = split_input_rows(2300)
        result = split_rows(rows)
        parts = ("train", "eval", "holdout")
        all_ids = [row["task_id"] for part in parts for row in result[part]]
        all_hashes = [compute_record_hash(row) for part in parts for row in result[part]]
        self.assertEqual(len(all_ids), len(set(all_ids)))
        self.assertEqual(len(all_hashes), len(set(all_hashes)))
        self.assertEqual(len(all_ids), 2300)

    def test_split_allocates_categories_proportionally(self):
        # Sizes chosen so no quota is exactly divisible: 461/688/459/461/231 of 2300.
        sizes = {"alpha": 461, "beta": 688, "gamma": 459, "delta": 461, "echo": 231}
        rows = []
        index = 0
        for category, size in sizes.items():
            for _ in range(size):
                rows.append(
                    {
                        "task_id": f"task-{index:05d}",
                        "task": {"id": f"task-{index:05d}", "prompt": f"prompt {index}", "category": category},
                        "response": f"```bash\necho {index}\n```",
                        "verification": "passed",
                    }
                )
                index += 1
        result = split_rows(rows)
        total = len(rows)
        worst = 0.0
        for part in ("eval", "holdout"):
            split_total = len(result[part])
            for category, size in sizes.items():
                observed = sum(1 for row in result[part] if row["task"]["category"] == category) / split_total
                worst = max(worst, abs(observed - size / total))
        self.assertLessEqual(worst, 0.01)
        self.assertAlmostEqual(result["balanceDelta"], worst, delta=1e-6)

    def test_split_category_falls_back_to_row_level_then_unknown(self):
        rows = split_input_rows(2300)
        for row in rows[:2300]:
            row["task"].pop("category", None)
            row["category"] = "flat"
        result = split_rows(rows)
        self.assertLessEqual(result["balanceDelta"], 0.1)
        rows = split_input_rows(2300)
        for row in rows:
            row["task"].pop("category", None)
        result = split_rows(rows)
        self.assertLessEqual(result["balanceDelta"], 0.1)  # all "unknown", perfectly balanced

    def test_split_rejects_tiny_input(self):
        with self.assertRaises(ValueError) as ctx:
            split_rows([{"task_id": "only"}], holdout_count=1)
        self.assertIn("accepted rows", str(ctx.exception))

    def test_split_rejects_unidentifiable_row(self):
        rows = split_input_rows(2300)
        rows.append({"task": {"prompt": ""}, "response": "   "})
        with self.assertRaises(ValueError):
            split_rows(rows)


if __name__ == "__main__":
    unittest.main()
