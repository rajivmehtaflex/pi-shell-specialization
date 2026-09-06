import os
import tempfile
import unittest
from pathlib import Path

from remote.pi_env.sandbox import (
    VERIFIER_DIRNAME,
    WORKSPACE_DIRNAME,
    RolloutWorkspace,
    cleanup_workspace,
    create_rollout_workspace,
    sanitize_task_id,
    write_setup_files,
)


class CreateRolloutWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-sandbox-test-")
        self.addCleanup(self._temporary.cleanup)
        self.sandbox_root = Path(self._temporary.name).resolve()

    def test_creates_expected_structure(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "task-001")
        root = Path(ws.root)
        self.assertTrue(root.is_dir())
        self.assertEqual(root.parent, self.sandbox_root)
        self.assertEqual(Path(ws.workspace), root / WORKSPACE_DIRNAME)
        self.assertEqual(Path(ws.verifier), root / VERIFIER_DIRNAME)
        self.assertTrue(Path(ws.workspace).is_dir())
        self.assertTrue(Path(ws.verifier).is_dir())
        self.assertEqual(Path(ws.trace_path), root / "trace.jsonl")
        self.assertTrue(Path(ws.trace_path).exists())

    def test_verifier_dir_is_outside_workspace_dir(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "task-001")
        verifier = Path(ws.verifier).resolve()
        workspace = Path(ws.workspace).resolve()
        self.assertTrue(verifier.parent == workspace.parent)
        self.assertNotIn(str(workspace) + os.sep, str(verifier))

    def test_workspace_roots_are_unique_per_call(self):
        first = create_rollout_workspace(str(self.sandbox_root), "task-001")
        second = create_rollout_workspace(str(self.sandbox_root), "task-001")
        self.assertNotEqual(first.root, second.root)

    def test_unsafe_task_id_is_sanitized(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "../evil/task id")
        root = Path(ws.root)
        self.assertEqual(root.parent, self.sandbox_root)
        self.assertNotIn("..", root.name)
        self.assertNotIn(os.sep, root.name)

    def test_blank_task_id_is_rejected(self):
        with self.assertRaises(ValueError):
            create_rollout_workspace(str(self.sandbox_root), "   ")

    def test_blank_sandbox_root_is_rejected(self):
        with self.assertRaises(ValueError):
            create_rollout_workspace("", "task-001")


class WriteSetupFilesTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-sandbox-test-")
        self.addCleanup(self._temporary.cleanup)
        self.ws = create_rollout_workspace(Path(self._temporary.name).resolve(), "task-001")

    def test_writes_files_into_workspace(self):
        write_setup_files(self.ws, {"notes.txt": "hello shell\n"})
        self.assertEqual((Path(self.ws.workspace) / "notes.txt").read_text(encoding="utf-8"), "hello shell\n")

    def test_creates_nested_directories(self):
        write_setup_files(self.ws, {"dir/sub/b.txt": "y"})
        self.assertEqual((Path(self.ws.workspace) / "dir/sub/b.txt").read_text(encoding="utf-8"), "y")

    def test_rejects_traversal_paths(self):
        with self.assertRaises(ValueError):
            write_setup_files(self.ws, {"../escape.txt": "nope"})

    def test_rejects_absolute_paths(self):
        with self.assertRaises(ValueError):
            write_setup_files(self.ws, {"/etc/escape": "nope"})

    def test_rejects_empty_mapping_is_noop(self):
        write_setup_files(self.ws, {})
        self.assertEqual(sorted(os.listdir(self.ws.workspace)), ["home", "tmp"])


class CleanupWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-sandbox-test-")
        self.addCleanup(self._temporary.cleanup)
        self.sandbox_root = Path(self._temporary.name).resolve()

    def test_cleanup_removes_the_whole_tree(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "task-001")
        write_setup_files(ws, {"a.txt": "x"})
        self.assertTrue(Path(ws.root).exists())
        cleanup_workspace(ws)
        self.assertFalse(Path(ws.root).exists())

    def test_cleanup_is_tolerant_when_root_already_gone(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "task-001")
        cleanup_workspace(ws)
        cleanup_workspace(ws)

    def test_refuses_empty_root(self):
        ws = RolloutWorkspace(root="", workspace="workspace", verifier="verifier", trace_path="trace.jsonl")
        with self.assertRaises(ValueError):
            cleanup_workspace(ws)

    def test_refuses_filesystem_root(self):
        ws = RolloutWorkspace(root="/", workspace="/workspace", verifier="/verifier", trace_path="/trace.jsonl")
        with self.assertRaises(ValueError):
            cleanup_workspace(ws)

    def test_refuses_root_outside_recorded_sandbox_root(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "task-001")
        ws.root = str(self.sandbox_root.parent / "elsewhere")
        with self.assertRaises(ValueError):
            cleanup_workspace(ws)

    def test_refuses_root_without_expected_prefix(self):
        ws = create_rollout_workspace(str(self.sandbox_root), "task-001")
        ws.root = str(self.sandbox_root / "unrelated-name")
        with self.assertRaises(ValueError):
            cleanup_workspace(ws)


class SanitizeTaskIdTests(unittest.TestCase):
    def test_keeps_safe_characters(self):
        self.assertEqual(sanitize_task_id("task-001"), "task-001")

    def test_replaces_separators_and_spaces(self):
        cleaned = sanitize_task_id("../evil task/id")
        self.assertNotIn("/", cleaned)
        self.assertNotIn(" ", cleaned)
        self.assertNotIn("..", cleaned.split("-"))

    def test_falls_back_to_task_when_empty(self):
        self.assertEqual(sanitize_task_id("///"), "task")


if __name__ == "__main__":
    unittest.main()
