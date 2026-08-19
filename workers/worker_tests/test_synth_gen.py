import unittest

from workers.synth_gen import synthesize


class SynthTests(unittest.TestCase):
    def test_seed_is_deterministic(self):
        row = {"id": "task-1", "dialect": "linux-bash5-gnu"}
        self.assertEqual(synthesize(row), synthesize(row))
        self.assertEqual(synthesize(row)["synth_id"], "synth-task-1")

    def test_task_payload_is_preserved(self):
        task = {"id": "task-2", "prompt": "copy", "dialect": "linux-bash5-gnu"}
        result = synthesize({"task": task})
        self.assertEqual(result["task"], task)


if __name__ == "__main__":
    unittest.main()
