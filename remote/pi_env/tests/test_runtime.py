"""Tests for real-executor glue (remote/pi_env/runtime.py)."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

from remote.pi_env.config import PiConfig
from remote.pi_env.runtime import (
    SubprocessRunner,
    RunResult,
    completions_url,
    default_upstream,
    load_config,
    run_rollout,
)
from remote.pi_env.task import PiTask
from workers.contracts import validate_envelope

from remote.pi_env.tests.fakes import FakeProcessRunner, post_json


VALID_ENV = {
    "PI_COMMAND": "pi",
    "PI_MODEL": "fake-model",
    "PI_EXTENSION_PATH": "/tmp/ext.js",
    "PI_ENDPOINT_URL": "http://127.0.0.1:9/v1",
    "PI_SANDBOX_ROOT": "/tmp/pi-sandbox",
}


class SubprocessRunnerTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-runtime-test-")
        self.addCleanup(self._temporary.cleanup)
        self.cwd = self._temporary.name
        self.runner = SubprocessRunner()

    def test_run_captures_stdout_exit_code_and_status(self):
        result = self.runner.run([sys.executable, "-c", "print('hello')"], cwd=self.cwd, env=dict(os.environ), timeout=30)
        self.assertIsInstance(result, RunResult)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.stdout, "hello\n")
        self.assertFalse(result.timed_out)

    def test_run_captures_stderr_and_nonzero_exit(self):
        result = self.runner.run([sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"], cwd=self.cwd, env=dict(os.environ), timeout=30)
        self.assertEqual(result.exit_code, 3)
        self.assertEqual(result.stderr, "boom")

    def test_run_honors_cwd_and_env(self):
        script = "import os, sys; print(os.getcwd(), os.environ['PROBE_VAR'])"
        result = self.runner.run([sys.executable, "-c", script], cwd=self.cwd, env={**os.environ, "PROBE_VAR": "probe-1"}, timeout=30)
        cwd_text, _, probe = result.stdout.strip().partition(" ")
        # Compare resolved paths: macOS reports /private/var for /var tempdirs.
        self.assertEqual(Path(cwd_text).resolve(), Path(self.cwd).resolve())
        self.assertEqual(probe, "probe-1")

    def test_run_kills_on_timeout_and_reports_timed_out(self):
        result = self.runner.run([sys.executable, "-c", "import time; time.sleep(30)"], cwd=self.cwd, env=dict(os.environ), timeout=1)
        self.assertEqual(result.status, "timed-out")
        self.assertTrue(result.timed_out)
        self.assertIsNone(result.exit_code)

    def test_run_reports_error_for_unspawnable_command(self):
        result = self.runner.run(["/nonexistent/pi-binary-xyz"], cwd=self.cwd, env=dict(os.environ), timeout=5)
        self.assertEqual(result.status, "error")
        self.assertFalse(result.timed_out)
        self.assertIsNone(result.exit_code)
        self.assertNotEqual(result.stderr, "")

    def test_to_execution_uses_envelope_vocabulary(self):
        execution = RunResult(status="completed", exit_code=2, stdout="out", stderr="err").to_execution()
        self.assertEqual(execution, {"status": "completed", "exitCode": 2, "stdout": "out", "stderr": "err"})


class LoadConfigTests(unittest.TestCase):
    def test_loads_and_requires_valid_config(self):
        config = load_config(VALID_ENV)
        self.assertIsInstance(config, PiConfig)
        self.assertEqual(config.pi_command, "pi")
        self.assertEqual(config.model, "fake-model")

    def test_missing_fields_raise_value_error(self):
        with self.assertRaises(ValueError):
            load_config({})

    def test_bad_timeout_is_flagged(self):
        with self.assertRaises(ValueError):
            load_config({**VALID_ENV, "PI_TIMEOUT_SECONDS": "zero"})


class CompletionsUrlTests(unittest.TestCase):
    def test_appends_default_path_to_bare_base_url(self):
        self.assertEqual(completions_url("http://host:8000"), "http://host:8000/v1/chat/completions")

    def test_strips_trailing_slash_before_joining(self):
        self.assertEqual(completions_url("http://host:8000/"), "http://host:8000/v1/chat/completions")

    def test_keeps_url_that_already_targets_completions(self):
        self.assertEqual(completions_url("http://host:8000/v1/chat/completions"), "http://host:8000/v1/chat/completions")

    def test_default_upstream_is_a_callable(self):
        upstream = default_upstream("http://127.0.0.1:9")
        self.assertTrue(callable(upstream))


class RunRolloutTests(unittest.TestCase):
    """run_rollout is the Wave-3 phase-script entry point; smoke-test the wiring."""

    def test_run_rollout_returns_a_valid_envelope_row(self):
        temporary = tempfile.TemporaryDirectory(prefix="pi-env-runtime-rollout-")
        self.addCleanup(temporary.cleanup)
        config = PiConfig(
            pi_command="pi",
            model="fake-model",
            extension_path="/tmp/ext.js",
            endpoint_url="http://127.0.0.1:9",
            sandbox_root=str(Path(temporary.name).resolve()),
            timeout_seconds=30,
        )

        def on_run(argv, cwd, env, timeout):
            post_json(env["OPENAI_BASE_URL"] + "/v1/chat/completions", {
                "model": "fake-model",
                "messages": [{"role": "user", "content": "work"}],
            })

        runner = FakeProcessRunner(results=[
            RunResult(status="completed", exit_code=0, stdout="ok\n", stderr="", timed_out=False),
        ], on_run=on_run)
        task = PiTask(task_id="rollout-smoke", prompt="say ok", checks=[
            {"type": "exit_code", "value": 0},
        ])

        envelope = run_rollout(task, config=config, runner=runner, upstream=lambda request: {
            "choices": [{"message": {"role": "assistant", "content": "ok then"}}],
        })

        self.assertEqual(validate_envelope(envelope), [])
        self.assertEqual(envelope["response"], "ok then")
        self.assertEqual(envelope["verification"], "passed")
        self.assertEqual(runner.run_count, 1)


if __name__ == "__main__":
    unittest.main()
