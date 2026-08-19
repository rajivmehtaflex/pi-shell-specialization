import unittest

from workers.teacher_audit import audit
from workers.split import split_rows


class DataPhaseTests(unittest.TestCase):
    def test_audit_accepts_verified_unique_rows(self):
        rows = [{"task_id": "a", "verification": "passed", "task": {"id": "a", "prompt": "copy"}}]
        accepted, report = audit(rows)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(report["rejected"], 0)

    def test_audit_rejects_duplicates_and_unverified(self):
        rows = [
            {"task_id": "a", "verification": "passed", "task": {"id": "a", "prompt": "copy"}},
            {"task_id": "a", "verification": "passed", "task": {"id": "a", "prompt": "copy"}},
            {"task_id": "b", "verification": "failed", "task": {"id": "b", "prompt": "bad"}},
        ]
        accepted, report = audit(rows)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(report["rejected"], 2)

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
