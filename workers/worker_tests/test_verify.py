import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from workers.contracts import content_hash, compute_record_hash, validate_envelope
from workers.verify import _prepare_layout, extract_bash_block, main, verify_response


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


class IsolationLayoutTests(unittest.TestCase):
    """T3.3: verifier/workspace separation mirroring the TS sandbox contract."""

    def setUp(self):
        self.task = {
            "id": "iso-copy",
            "prompt": "Copy the file named 'hello world.txt' to 'copied.txt' keeping its contents.",
            "setupFiles": {"hello world.txt": "hello shell\n"},
            "environment": {"INPUT_FILE": "hello world.txt"},
            "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
            "failureLabels": ["word-splitting"],
        }

    def test_layout_splits_workspace_and_verifier(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            workspace, verifier = _prepare_layout(root)
            self.assertEqual(workspace, root / "workspace")
            self.assertEqual(verifier, root / "verifier")
            self.assertTrue(workspace.is_dir())
            self.assertTrue(verifier.is_dir())
            # verifier tree lives outside the candidate-visible workspace
            self.assertNotIn(str(verifier), str(workspace))
            self.assertEqual(verifier.parent, root)
            for child in ("home", "tmp"):
                self.assertTrue((workspace / child).is_dir())

    def test_candidate_universe_is_workspace_only(self):
        # Asserted from inside the sandbox: TEST_ROOT is the workspace and the
        # verifier directory exists one level above it, outside the universe.
        task = {
            "id": "iso-universe",
            "prompt": "Report that the layout is intact.",
            "checks": [{"type": "stdout_contains", "value": "universe-ok"}],
            "failureLabels": ["functional"],
        }
        script = (
            "```bash\n"
            'case "$TEST_ROOT" in */workspace) ;; *) exit 4 ;; esac\n'
            'test -d "$TEST_ROOT/../verifier" || exit 3\n'
            '[ "$(basename "$PWD")" = "workspace" ] || exit 5\n'
            'test -d "$TEST_ROOT/home" || exit 6\n'
            'test -d "$TEST_ROOT/tmp" || exit 7\n'
            'echo universe-ok\n'
            "```"
        )
        result = verify_response(task, script)
        self.assertEqual(result["verification"], "passed", result)
        self.assertEqual(result["execution"]["status"], "passed")

    def test_setup_and_candidate_live_inside_workspace(self):
        # The candidate can see its own setup file via the workspace-relative
        # TEST_ROOT, proving setup files are inside the candidate universe.
        result = verify_response(self.task, '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```')
        self.assertEqual(result["verification"], "passed", result)

    def test_file_check_target_outside_workspace_rejected(self):
        # A candidate writing files cannot forge a file_exists check that
        # targets a path outside the workspace: the check itself is rejected
        # as an evaluator-config error before its existence is evaluated.
        task = {
            "id": "iso-escape",
            "prompt": "Escape the workspace.",
            "setupFiles": {"seed.txt": "seed\n"},
            "checks": [{"type": "file_exists", "path": "../escaped.txt"}],
            "failureLabels": ["functional"],
        }
        script = "```bash\nmkdir -p \"$TEST_ROOT/..\" 2>/dev/null; echo pwned > \"$TEST_ROOT/../escaped.txt\"\n```"
        result = verify_response(task, script)
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "failed")
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertIn("escapes", result["execution"]["error"])

    def test_file_check_absolute_target_outside_workspace_rejected(self):
        task = {
            "id": "iso-escape-abs",
            "prompt": "Escape the workspace with an absolute path.",
            "checks": [{"type": "file_exists", "path": "/etc/passwd"}],
            "failureLabels": ["functional"],
        }
        result = verify_response(task, "```bash\ncat /etc/passwd\n```")
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertIn("escapes", result["execution"]["error"])

    def test_file_check_absent_variant_rejected_outside_workspace(self):
        # The absent=true flavor must not become an oracle for outside paths.
        task = {
            "id": "iso-escape-absent",
            "prompt": "Prove absence outside the workspace.",
            "checks": [{"type": "file_exists", "path": "../../outside.txt", "absent": True}],
            "failureLabels": ["functional"],
        }
        result = verify_response(task, "```bash\ntrue\n```")
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["failureLabels"], ["evaluator"])

    def test_file_check_inside_workspace_still_works(self):
        task = {
            "id": "iso-inside",
            "prompt": "Create a file inside the workspace.",
            "checks": [{"type": "file_exists", "path": "made.txt", "absent": False}],
            "failureLabels": ["functional"],
        }
        result = verify_response(task, "```bash\necho hi > \"$TEST_ROOT/made.txt\"\n```")
        self.assertEqual(result["verification"], "passed", result)


class TaskValidationTests(unittest.TestCase):
    """T4.2: pre-execution evaluator-config validation (substantive checks + single exit-code spec)."""

    def setUp(self):
        self.task = {
            "id": "val-copy",
            "prompt": "Copy the file named 'hello world.txt' to 'copied.txt' keeping its contents.",
            "setupFiles": {"hello world.txt": "hello shell\n"},
            "environment": {"INPUT_FILE": "hello world.txt"},
            "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
            "failureLabels": ["word-splitting"],
        }
        self.good_response = '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```'

    def _verify_without_execution(self, task):
        with mock.patch("workers.verify.subprocess.run") as run_mock:
            result = verify_response(task, self.good_response)
        self.assertFalse(run_mock.called, "no process may be launched for an invalid task")
        return result

    def test_missing_checks_rejected_pre_execution(self):
        task = dict(self.task)
        del task["checks"]
        result = self._verify_without_execution(task)
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "failed")
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertEqual(result["execution"]["error"], "task has no substantive checks")
        self.assertEqual(result["execution"]["syntax"], "not-run")

    def test_empty_checks_rejected_pre_execution_without_side_effects(self):
        # The setup files would create a marker if setup ran; assert nothing ran.
        task = {
            "id": "val-empty",
            "prompt": "Create marker.txt.",
            "setupFiles": {"marker.txt": "side effect\n"},
            "checks": [],
        }
        result = self._verify_without_execution(task)
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertEqual(result["execution"]["error"], "task has no substantive checks")

    def test_non_list_checks_rejected_pre_execution(self):
        result = self._verify_without_execution({**self.task, "checks": "file_contains"})
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertEqual(result["execution"]["error"], "task checks must be a list")

    def test_exit_code_only_checks_rejected_pre_execution(self):
        task = {
            "id": "val-exit-only",
            "prompt": "Exit cleanly.",
            "checks": [{"type": "exit_code", "value": 0}],
        }
        result = self._verify_without_execution(task)
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertEqual(result["execution"]["error"], "task has no substantive checks")

    def test_unsupported_check_type_named_in_rejection(self):
        task = {
            "id": "val-unsupported",
            "prompt": "Prove a file is absent.",
            "checks": [{"type": "file_absent", "path": "ghost.txt"}],
        }
        result = self._verify_without_execution(task)
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertEqual(result["execution"]["error"], "unsupported check type: file_absent")

    def test_redundant_exit_code_check_is_deduped(self):
        from workers.verify import _validate_task

        checks = [{"type": "exit_code", "value": 0}, {"type": "file_contains", "path": "copied.txt", "value": "hello shell"}]
        effective, error = _validate_task({**self.task, "expectedExitCode": 0, "checks": checks})
        self.assertIsNone(error)
        self.assertEqual(effective, [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}])
        # End to end: the task still passes with the single canonical gate.
        result = verify_response({**self.task, "expectedExitCode": 0, "checks": checks}, self.good_response)
        self.assertEqual(result["verification"], "passed", result)
        self.assertEqual(result["execution"]["exitCode"], 0)

    def test_conflicting_exit_code_rejected_pre_execution(self):
        task = {
            "id": "val-conflict",
            "prompt": "Copy a file.",
            "expectedExitCode": 0,
            "checks": [
                {"type": "exit_code", "value": 1},
                {"type": "file_contains", "path": "copied.txt", "value": "hello shell"},
            ],
        }
        result = self._verify_without_execution(task)
        self.assertEqual(result["failureLabels"], ["evaluator"])
        self.assertEqual(result["execution"]["error"], "conflicting exit code: expectedExitCode=0 vs exit_code check=1")

    def test_validate_task_rejects_non_dict_check(self):
        from workers.verify import _validate_task

        effective, error = _validate_task({**self.task, "checks": ["file_contains"]})
        self.assertEqual(error, "each check must be an object")
        self.assertEqual(effective, [])


if __name__ == "__main__":
    unittest.main()
