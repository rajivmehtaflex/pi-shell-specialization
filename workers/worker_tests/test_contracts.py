import copy
import unittest

from workers.contracts import (
    assert_valid_envelope,
    compute_record_hash,
    content_hash,
    normalize_text,
    validate_envelope,
)

PINNED_HASH = "948a41ef29de3b185c57990fdc6bf3588d2d1308b9aba94f8cdc4fe137b926d3"


def make_envelope() -> dict:
    record = {
        "task_id": "task-001",
        "task": {
            "prompt": "List files in /tmp\n",
            "setupFiles": {"notes.txt": "hello shell\n"},
            "checks": [{"type": "stdout_contains", "value": "notes.txt"}],
        },
        "response": "```bash\nls /tmp\n```\n",
        "verification": "passed",
        "execution": {"exitCode": 0, "stdout": "notes.txt\n", "stderr": "", "durationMs": 12},
        "failureLabels": [],
        "provenance": {
            "session_id": "session-abc",
            "model": "bench-model",
            "provider": "bench-provider",
            "track": "pi-tools",
            "attempt": 1,
        },
    }
    record["content_hash"] = compute_record_hash(record)
    return record


class ContractsTests(unittest.TestCase):
    def setUp(self):
        self.envelope = make_envelope()

    def rehash(self, record):
        record["content_hash"] = compute_record_hash(record)
        return record

    def problems_for(self, record):
        return validate_envelope(record)

    def test_valid_envelope_passes_with_no_problems(self):
        self.assertEqual(self.problems_for(self.envelope), [])
        assert_valid_envelope(self.envelope)

    def test_missing_task_id_rejected(self):
        del self.envelope["task_id"]
        self.assertTrue(any("task_id" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_empty_task_id_rejected(self):
        self.envelope["task_id"] = "  "
        self.assertTrue(any("task_id" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_missing_response_rejected(self):
        del self.envelope["response"]
        self.assertTrue(any("response" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_empty_response_rejected(self):
        self.envelope["response"] = "   "
        self.assertTrue(any("response" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_missing_task_prompt_rejected(self):
        self.envelope["task"] = {"setupFiles": {}, "checks": []}
        self.assertTrue(any("prompt" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_empty_task_prompt_rejected(self):
        self.envelope["task"] = {**self.envelope["task"], "prompt": ""}
        self.assertTrue(any("prompt" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_extra_task_keys_are_allowed(self):
        self.envelope["task"] = {**self.envelope["task"], "customSection": {"any": "thing"}}
        self.assertEqual(self.problems_for(self.envelope), [])

    def test_bad_verification_value_rejected(self):
        self.envelope["verification"] = "unknown"
        self.assertTrue(any("verification" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_missing_execution_rejected(self):
        del self.envelope["execution"]
        self.assertTrue(any("execution" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_non_dict_execution_rejected(self):
        self.envelope["execution"] = "exit 0"
        self.assertTrue(any("execution" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_failure_labels_must_be_list_of_strings(self):
        self.envelope["failureLabels"] = ["word-splitting", 3]
        self.assertTrue(any("failureLabels" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_failure_labels_must_be_a_list(self):
        self.envelope["failureLabels"] = "word-splitting"
        self.assertTrue(any("failureLabels" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_provenance_track_rejects_unknown_value(self):
        self.envelope["provenance"] = {**self.envelope["provenance"], "track": "other"}
        self.assertTrue(any("track" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_provenance_attempt_must_be_positive_integer(self):
        for bad_attempt in (0, -1, "1", True):
            self.envelope["provenance"] = {**self.envelope["provenance"], "attempt": bad_attempt}
            self.assertTrue(any("attempt" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_provenance_session_id_must_be_non_empty(self):
        self.envelope["provenance"] = {**self.envelope["provenance"], "session_id": ""}
        self.assertTrue(any("session_id" in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_provenance_model_and_provider_must_be_non_empty(self):
        for key in ("model", "provider"):
            self.envelope["provenance"] = {**self.envelope["provenance"], key: " "}
            self.assertTrue(any(key in problem for problem in self.problems_for(self.rehash(self.envelope))))

    def test_same_task_and_response_under_different_task_ids_same_hash(self):
        other = copy.deepcopy(self.envelope)
        other["task_id"] = "task-999"
        other["content_hash"] = compute_record_hash(other)
        self.assertEqual(self.envelope["content_hash"], other["content_hash"])
        self.assertEqual(self.problems_for(other), [])

    def test_content_hash_matches_pinned_cross_language_vector(self):
        self.assertEqual(content_hash("List files in /tmp\n", "```bash\nls /tmp\n```\n"), PINNED_HASH)

    def test_normalize_text_collapses_whitespace_runs(self):
        self.assertEqual(normalize_text("```bash\nls /tmp\n```\n"), "```bash ls /tmp ```")
        self.assertEqual(normalize_text("List files in /tmp\n"), "List files in /tmp")
        self.assertEqual(normalize_text("  a \t\n b\t c  "), "a b c")

    def test_tampered_content_hash_rejected(self):
        self.envelope["content_hash"] = "f" * 64
        self.assertTrue(any("content_hash" in problem for problem in self.problems_for(self.envelope)))

    def test_malformed_content_hash_rejected(self):
        for bad_hash in ("XYZ", "948a41ef", "A" * 64, 12345):
            self.envelope["content_hash"] = bad_hash
            self.assertTrue(any("content_hash" in problem for problem in self.problems_for(self.envelope)))

    def test_hash_independent_of_key_insertion_order(self):
        first = {"response": "```bash ls /tmp ```", "task": {"prompt": "List files in /tmp", "checks": []}}
        second = {"task": {"checks": [], "prompt": "List files in /tmp"}, "response": "```bash ls /tmp ```"}
        self.assertEqual(compute_record_hash(first), compute_record_hash(second))
        self.assertEqual(compute_record_hash(first), content_hash("List files in /tmp", "```bash ls /tmp ```"))

    def test_assert_valid_envelope_raises_listing_all_problems(self):
        self.envelope["verification"] = "unknown"
        self.envelope["content_hash"] = "0" * 64
        with self.assertRaises(ValueError) as raised:
            assert_valid_envelope(self.envelope)
        message = str(raised.exception)
        self.assertIn("verification", message)
        self.assertIn("content_hash", message)


if __name__ == "__main__":
    unittest.main()
