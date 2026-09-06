import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from workers.contracts import content_hash, compute_record_hash, validate_envelope
from workers.verify import extract_bash_block, main, verify_response


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.task = {
            "id": "test-copy",
            "prompt": "Copy the file named 'hello world.txt' to 'copied.txt' keeping its contents.",
            "setupFiles": {"hello world.txt": "hello shell\n"},
            "environment": {"INPUT_FILE": "hello world.txt"},
            "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
            "failureLabels": ["word-splitting"],
        }
        self.good_response = '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```'

    def test_extracts_single_bash_block(self):
        self.assertEqual(extract_bash_block("```bash\necho hi\n```"), "echo hi\n")

    def test_verified_quoted_copy_passes(self):
        result = verify_response(self.task, self.good_response)
        self.assertEqual(result["verification"], "passed")
        self.assertEqual(result["execution"]["status"], "passed")

    def test_unquoted_copy_fails(self):
        result = verify_response(self.task, "```bash\ncp $INPUT_FILE $TEST_ROOT/copied.txt\n```")
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "failed")

    def test_network_command_is_blocked(self):
        result = verify_response(self.task, "```bash\ncurl https://example.com\n```")
        self.assertIn("network-access", result["failureLabels"])
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "failed")

    def test_passing_output_is_valid_envelope(self):
        result = verify_response(self.task, self.good_response)
        self.assertEqual(validate_envelope(result), [])

    def test_failed_output_is_valid_envelope(self):
        result = verify_response(self.task, "```bash\ncp $INPUT_FILE $TEST_ROOT/copied.txt\n```")
        self.assertEqual(validate_envelope(result), [])
        self.assertEqual(result["verification"], "failed")

    def test_output_preserves_full_task_object(self):
        result = verify_response(self.task, self.good_response)
        self.assertEqual(result["task"], self.task)
        self.assertEqual(result["task"]["setupFiles"]["hello world.txt"], "hello shell\n")
        self.assertEqual(
            result["task"]["checks"],
            [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
        )

    def test_execution_fields_are_nested(self):
        result = verify_response(self.task, self.good_response)
        execution = result["execution"]
        for key in ("status", "syntax", "exitCode", "stdout", "stderr", "durationMs", "findings"):
            self.assertIn(key, execution)
        self.assertEqual(execution["syntax"], "passed")
        self.assertEqual(execution["exitCode"], 0)
        self.assertIsInstance(execution["durationMs"], int)

    def test_provenance_fields_flow_through_from_input_row(self):
        provided = {
            "session_id": "sess-abc",
            "model": "teacher-large",
            "provider": "external-lab",
            "track": "pi-tools",
            "attempt": "3",
        }
        result = verify_response(self.task, self.good_response, provenance=provided)
        self.assertEqual(
            result["provenance"],
            {
                "session_id": "sess-abc",
                "model": "teacher-large",
                "provider": "external-lab",
                "track": "pi-tools",
                "attempt": 3,
            },
        )
        self.assertEqual(validate_envelope(result), [])

    def test_provenance_defaults_when_absent(self):
        result = verify_response(self.task, self.good_response)
        self.assertEqual(
            result["provenance"],
            {
                "session_id": "verify-test-copy",
                "model": "teacher",
                "provider": "external",
                "track": "raw",
                "attempt": 1,
            },
        )

    def test_invalid_provenance_values_fall_back_to_defaults(self):
        provided = {"session_id": "", "model": 7, "track": "not-a-track", "attempt": "two"}
        result = verify_response(self.task, self.good_response, provenance=provided)
        self.assertEqual(result["provenance"]["session_id"], "verify-test-copy")
        self.assertEqual(result["provenance"]["model"], "teacher")
        self.assertEqual(result["provenance"]["track"], "raw")
        self.assertEqual(result["provenance"]["attempt"], 1)
        self.assertEqual(validate_envelope(result), [])

    def test_content_hash_present_and_stable(self):
        first = verify_response(self.task, self.good_response)
        second = verify_response(self.task, self.good_response)
        self.assertRegex(first["content_hash"], r"^[0-9a-f]{64}$")
        self.assertEqual(first["content_hash"], second["content_hash"])
        self.assertEqual(first["content_hash"], compute_record_hash(first))
        self.assertEqual(first["content_hash"], content_hash(self.task["prompt"], self.good_response))

    def test_main_passes_row_level_provenance_through(self):
        row = {
            "task": self.task,
            "response": self.good_response,
            "session_id": "sess-row",
            "model": "teacher-row",
            "provider": "provider-row",
            "track": "pi-tools",
            "attempt": 2,
        }
        with tempfile.TemporaryDirectory() as tmp:
            input_path = Path(tmp) / "input.jsonl"
            output_path = Path(tmp) / "out.jsonl"
            input_path.write_text(json.dumps(row) + "\n", encoding="utf-8")
            with mock.patch("sys.argv", ["verify.py", "--input", str(input_path), "--out", str(output_path)]):
                self.assertEqual(main(), 0)
            emitted = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(validate_envelope(emitted), [])
        self.assertEqual(emitted["provenance"]["session_id"], "sess-row")
        self.assertEqual(emitted["provenance"]["track"], "pi-tools")
        self.assertEqual(emitted["provenance"]["attempt"], 2)


if __name__ == "__main__":
    unittest.main()
