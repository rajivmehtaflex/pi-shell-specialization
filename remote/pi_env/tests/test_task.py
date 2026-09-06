import unittest

from remote.pi_env.task import SUPPORTED_CHECK_TYPES, PiTask, is_safe_relative_path


def make_task() -> PiTask:
    return PiTask(
        task_id="task-001",
        prompt="Copy notes.txt to copied.txt",
        setup_files={"notes.txt": "hello shell\n"},
        environment={"INPUT_FILE": "notes.txt"},
        checks=[{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
    )


class TaskValidationTests(unittest.TestCase):
    def test_valid_task_has_no_problems(self):
        task = make_task()
        self.assertEqual(task.validate(), [])
        task.require_valid()

    def test_blank_task_id_is_flagged(self):
        for task_id in ("", "   "):
            with self.subTest(task_id=task_id):
                task = make_task()
                task.task_id = task_id
                self.assertTrue(any("task_id" in problem for problem in task.validate()))

    def test_blank_prompt_is_flagged(self):
        task = make_task()
        task.prompt = ""
        self.assertTrue(any("prompt" in problem for problem in task.validate()))

    def test_empty_checks_are_flagged(self):
        task = make_task()
        task.checks = []
        self.assertTrue(any("checks" in problem for problem in task.validate()))

    def test_unsupported_check_type_is_flagged(self):
        task = make_task()
        task.checks = [{"type": "stderr_contains", "value": "x"}]
        problems = task.validate()
        self.assertTrue(any("stderr_contains" in problem for problem in problems), problems)
        self.assertTrue(any("unsupported" in problem for problem in problems), problems)

    def test_non_dict_check_is_flagged(self):
        task = make_task()
        task.checks = ["stdout_contains"]  # type: ignore[list-item]
        self.assertTrue(any("checks[0]" in problem for problem in task.validate()))

    def test_supported_check_types_match_verifier_vocabulary(self):
        self.assertEqual(
            SUPPORTED_CHECK_TYPES,
            ("stdout_exact", "stdout_contains", "exit_code", "file_exists", "file_contains", "file_empty"),
        )

    def test_non_list_checks_are_flagged(self):
        task = make_task()
        task.checks = {"type": "stdout_contains"}  # type: ignore[assignment]
        self.assertTrue(any("checks" in problem for problem in task.validate()))


class CheckFieldTests(unittest.TestCase):
    def assert_flagged(self, check, fragment):
        task = make_task()
        task.checks = [check]
        problems = task.validate()
        self.assertTrue(any(fragment in problem for problem in problems), problems)

    def test_stdout_exact_requires_value(self):
        self.assert_flagged({"type": "stdout_exact"}, "value")

    def test_stdout_contains_requires_value(self):
        self.assert_flagged({"type": "stdout_contains"}, "value")

    def test_exit_code_requires_integer_value(self):
        self.assert_flagged({"type": "exit_code"}, "value")
        self.assert_flagged({"type": "exit_code", "value": "0"}, "value")
        self.assert_flagged({"type": "exit_code", "value": True}, "value")

    def test_exit_code_accepts_integer_value(self):
        task = make_task()
        task.checks = [{"type": "exit_code", "value": 1}]
        self.assertEqual(task.validate(), [])

    def test_file_exists_requires_path(self):
        self.assert_flagged({"type": "file_exists"}, "path")

    def test_file_contains_requires_path_and_value(self):
        self.assert_flagged({"type": "file_contains", "path": "a.txt"}, "value")
        self.assert_flagged({"type": "file_contains", "value": "x"}, "path")

    def test_file_empty_requires_path(self):
        self.assert_flagged({"type": "file_empty"}, "path")


class SetupPathTests(unittest.TestCase):
    def test_valid_task_setup_paths_pass(self):
        task = make_task()
        task.setup_files = {"a.txt": "x", "dir/sub/b.txt": "y"}
        self.assertEqual(task.validate(), [])

    def test_traversal_setup_path_is_flagged(self):
        task = make_task()
        task.setup_files = {"../x": "content"}
        self.assertTrue(any("setup_files" in problem for problem in task.validate()))

    def test_absolute_setup_path_is_flagged(self):
        task = make_task()
        task.setup_files = {"/etc/x": "content"}
        self.assertTrue(any("setup_files" in problem for problem in task.validate()))

    def test_nested_traversal_setup_path_is_flagged(self):
        task = make_task()
        task.setup_files = {"dir/../../x": "content"}
        self.assertTrue(any("setup_files" in problem for problem in task.validate()))

    def test_empty_setup_key_is_flagged(self):
        task = make_task()
        task.setup_files = {"": "content"}
        self.assertTrue(any("setup_files" in problem for problem in task.validate()))


class SafeRelativePathTests(unittest.TestCase):
    def test_accepts_plain_relative_paths(self):
        self.assertTrue(is_safe_relative_path("a.txt"))
        self.assertTrue(is_safe_relative_path("dir/sub/b.txt"))
        self.assertTrue(is_safe_relative_path("./c.txt"))

    def test_rejects_dangerous_paths(self):
        for path in ("", "   ", ".", "..", "/etc/x", "../x", "a/../..", "dir/../..", "a/../../b", "C:\\x"):
            with self.subTest(path=path):
                self.assertFalse(is_safe_relative_path(path))

    def test_rejects_non_string_paths(self):
        self.assertFalse(is_safe_relative_path(None))  # type: ignore[arg-type]
        self.assertFalse(is_safe_relative_path(5))  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
