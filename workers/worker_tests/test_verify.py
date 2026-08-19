import unittest

from workers.verify import extract_bash_block, verify_response


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.task = {
            "id": "test-copy",
            "setupFiles": {"hello world.txt": "hello shell\n"},
            "environment": {"INPUT_FILE": "hello world.txt"},
            "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
            "failureLabels": ["word-splitting"],
        }

    def test_extracts_single_bash_block(self):
        self.assertEqual(extract_bash_block("```bash\necho hi\n```"), "echo hi\n")

    def test_verified_quoted_copy_passes(self):
        result = verify_response(self.task, '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```')
        self.assertEqual(result["status"], "passed")

    def test_unquoted_copy_fails(self):
        result = verify_response(self.task, "```bash\ncp $INPUT_FILE $TEST_ROOT/copied.txt\n```")
        self.assertEqual(result["status"], "failed")

    def test_network_command_is_blocked(self):
        result = verify_response(self.task, "```bash\ncurl https://example.com\n```")
        self.assertIn("network-access", result["failureLabels"])


if __name__ == "__main__":
    unittest.main()
