import unittest

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

    def test_split_is_deterministic_and_disjoint(self):
        rows = [{"task_id": f"task-{i}"} for i in range(10)]
        first = split_rows(rows, seed=42, holdout_count=2)
        second = split_rows(rows, seed=42, holdout_count=2)
        self.assertEqual(first, second)
        ids = [row["task_id"] for part in first.values() for row in part]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(first["holdout"]), 2)

    def test_split_requires_extra_rows_for_holdout(self):
        with self.assertRaises(ValueError):
            split_rows([{"task_id": "only"}], holdout_count=1)


if __name__ == "__main__":
    unittest.main()
