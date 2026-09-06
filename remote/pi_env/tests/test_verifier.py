"""Tests for the hidden Pi rollout verifier (remote/pi_env/verifier.py).

The check semantics must mirror workers/verify.py::_check exactly:
stdout_exact / stdout_contains compare captured stdout, exit_code compares the
captured exit code, file_* inspect files under the candidate workspace (with
the "absent" flag honored on file_exists).
"""

import tempfile
import unittest
from pathlib import Path

from remote.pi_env.sandbox import create_rollout_workspace
from remote.pi_env.task import PiTask
from remote.pi_env.verifier import (
    check_passes,
    read_workspace_file,
    run_verifier,
)


def snapshot(status="completed", exit_code=0, stdout="", stderr=""):
    return {"status": status, "exitCode": exit_code, "stdout": stdout, "stderr": stderr}


class VerifierWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-verifier-test-")
        self.addCleanup(self._temporary.cleanup)
        self.ws = create_rollout_workspace(Path(self._temporary.name).resolve(), "task-001")

    def task(self, checks):
        return PiTask(task_id="task-001", prompt="do it", checks=checks)

    def test_passing_checks_report_passed(self):
        (Path(self.ws.workspace) / "out.txt").write_text("created\n", encoding="utf-8")
        result = run_verifier(self.ws, self.task([
            {"type": "file_exists", "path": "out.txt"},
            {"type": "file_contains", "path": "out.txt", "value": "created"},
            {"type": "exit_code", "value": 0},
            {"type": "stdout_contains", "value": "done"},
            {"type": "stdout_exact", "value": "done\n"},
        ]), snapshot(stdout="done\n"))
        self.assertEqual(result["verification"], "passed")
        self.assertEqual(result["execution"]["status"], "passed")
        self.assertEqual(result["execution"]["exitCode"], 0)
        self.assertEqual(result["failureLabels"], [])

    def test_failing_check_reports_failed_with_functional_label(self):
        result = run_verifier(self.ws, self.task([
            {"type": "file_exists", "path": "missing.txt"},
        ]), snapshot())
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "failed")
        self.assertEqual(result["failureLabels"], ["functional"])

    def test_stdout_exact_requires_full_match(self):
        self.assertTrue(check_passes({"type": "stdout_exact", "value": "a b"}, self.ws.workspace, "a b", 0))
        self.assertFalse(check_passes({"type": "stdout_exact", "value": "a"}, self.ws.workspace, "a b", 0))

    def test_stdout_contains_is_substring_semantics(self):
        self.assertTrue(check_passes({"type": "stdout_contains", "value": "ell"}, self.ws.workspace, "hello", 0))
        self.assertFalse(check_passes({"type": "stdout_contains", "value": "world"}, self.ws.workspace, "hello", 0))

    def test_exit_code_compares_captured_exit_code(self):
        self.assertTrue(check_passes({"type": "exit_code", "value": 2}, self.ws.workspace, "", 2))
        self.assertFalse(check_passes({"type": "exit_code", "value": 0}, self.ws.workspace, "", 2))

    def test_file_exists_honors_absent_flag(self):
        self.assertTrue(check_passes({"type": "file_exists", "path": "x.txt"}, self.ws.workspace, "", 0) is False)
        self.assertTrue(check_passes({"type": "file_exists", "path": "x.txt", "absent": True}, self.ws.workspace, "", 0))
        (Path(self.ws.workspace) / "x.txt").write_text("x", encoding="utf-8")
        self.assertTrue(check_passes({"type": "file_exists", "path": "x.txt"}, self.ws.workspace, "", 0))
        self.assertFalse(check_passes({"type": "file_exists", "path": "x.txt", "absent": True}, self.ws.workspace, "", 0))

    def test_file_contains_missing_file_reads_as_empty(self):
        self.assertFalse(check_passes({"type": "file_contains", "path": "nope.txt", "value": "a"}, self.ws.workspace, "", 0))

    def test_file_empty_passes_only_for_empty_content(self):
        (Path(self.ws.workspace) / "empty.txt").write_text("", encoding="utf-8")
        (Path(self.ws.workspace) / "full.txt").write_text("data", encoding="utf-8")
        self.assertTrue(check_passes({"type": "file_empty", "path": "empty.txt"}, self.ws.workspace, "", 0))
        self.assertFalse(check_passes({"type": "file_empty", "path": "full.txt"}, self.ws.workspace, "", 0))
        self.assertTrue(check_passes({"type": "file_empty", "path": "never-created.txt"}, self.ws.workspace, "", 0))

    def test_checks_resolve_inside_workspace_only(self):
        # Verifier assets live in ws.verifier (a sibling of the workspace) and
        # must be invisible to file checks, which resolve against the workspace.
        (Path(self.ws.verifier) / "secret.txt").write_text("answers", encoding="utf-8")
        self.assertFalse(check_passes({"type": "file_exists", "path": "secret.txt"}, self.ws.workspace, "", 0))
        result = run_verifier(self.ws, self.task([
            {"type": "file_exists", "path": "secret.txt", "absent": True},
        ]), snapshot())
        self.assertEqual(result["verification"], "passed")

    def test_unsafe_check_path_is_rejected_up_front(self):
        # PiTask.validate rejects unsafe check paths outright, so require_valid
        # fires before any check is evaluated.
        with self.assertRaises(ValueError):
            run_verifier(self.ws, self.task([
                {"type": "file_exists", "path": "../escape.txt"},
            ]), snapshot())

    def test_read_workspace_file_returns_empty_for_missing_file(self):
        self.assertEqual(read_workspace_file(self.ws.workspace, "ghost.txt"), "")

    def test_traversal_reads_are_refused(self):
        with self.assertRaises(ValueError):
            read_workspace_file(self.ws.workspace, "../outside.txt")

    def test_nested_paths_are_supported(self):
        nested = Path(self.ws.workspace) / "dir" / "sub"
        nested.mkdir(parents=True)
        (nested / "f.txt").write_text("deep", encoding="utf-8")
        self.assertTrue(check_passes({"type": "file_contains", "path": "dir/sub/f.txt", "value": "deep"}, self.ws.workspace, "", 0))


class VerifierContractTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-verifier-test-")
        self.addCleanup(self._temporary.cleanup)
        self.ws = create_rollout_workspace(Path(self._temporary.name).resolve(), "task-001")

    def test_invalid_task_is_rejected_before_any_check_runs(self):
        with self.assertRaises(ValueError):
            run_verifier(self.ws, PiTask(task_id="task-001", prompt="do it", checks=[]), snapshot())
        with self.assertRaises(ValueError):
            run_verifier(self.ws, PiTask(task_id="task-001", prompt="do it", checks=[
                {"type": "teleport", "path": "x.txt"},
            ]), snapshot())

    def test_runner_may_be_a_zero_arg_callable(self):
        seen = []
        result = run_verifier(self.ws, PiTask(task_id="t", prompt="p", checks=[
            {"type": "stdout_exact", "value": "hi"},
        ]), lambda: seen.append(1) or snapshot(stdout="hi"))
        self.assertEqual(result["verification"], "passed")
        self.assertEqual(seen, [1])

    def test_timed_out_pi_is_still_verified_but_forced_failed(self):
        (Path(self.ws.workspace) / "input.txt").write_text("data", encoding="utf-8")
        result = run_verifier(self.ws, PiTask(task_id="t", prompt="p", checks=[
            {"type": "file_exists", "path": "input.txt"},
        ]), snapshot(status="timed-out", exit_code=None))
        # The file check itself passes, but a timed-out rollout can never pass.
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "timed-out")
        self.assertEqual(result["failureLabels"], ["timeout"])
        self.assertIsNone(result["execution"]["exitCode"])

    def test_launch_error_is_reported_failed(self):
        result = run_verifier(self.ws, PiTask(task_id="t", prompt="p", checks=[
            {"type": "exit_code", "value": 0},
        ]), snapshot(status="error", exit_code=None, stderr="spawn failed"))
        self.assertEqual(result["verification"], "failed")
        self.assertEqual(result["execution"]["status"], "failed")
        self.assertEqual(result["failureLabels"], ["launch"])
        self.assertEqual(result["execution"]["stderr"], "spawn failed")

    def test_execution_snapshot_keys_accept_snake_case_exit_code(self):
        result = run_verifier(self.ws, PiTask(task_id="t", prompt="p", checks=[
            {"type": "exit_code", "value": 3},
        ]), {"status": "completed", "exit_code": 3, "stdout": "", "stderr": ""})
        self.assertEqual(result["verification"], "passed")
        self.assertEqual(result["execution"]["exitCode"], 3)

    def test_verifier_returns_only_the_documented_shape(self):
        result = run_verifier(self.ws, PiTask(task_id="t", prompt="p", checks=[
            {"type": "exit_code", "value": 0},
        ]), snapshot())
        self.assertEqual(set(result), {"verification", "execution", "failureLabels"})
        self.assertEqual(set(result["execution"]), {"status", "exitCode", "stdout", "stderr"})


if __name__ == "__main__":
    unittest.main()
