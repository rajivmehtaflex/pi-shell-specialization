"""Unit tests for the rollout harness (remote/pi_env/harness.py)."""

import json
import os
import tempfile
import unittest
from pathlib import Path

from remote.pi_env.config import PiConfig
from remote.pi_env.harness import (
    RolloutHarness,
    RolloutOutcome,
    build_envelope_row,
    build_pi_command,
    build_pi_env,
    extract_assistant_content,
    split_trace,
)
from remote.pi_env.interception import AUXILIARY, TRAINING
from remote.pi_env.runtime import RunResult
from remote.pi_env.sandbox import create_rollout_workspace
from remote.pi_env.task import PiTask
from workers.contracts import validate_envelope

from remote.pi_env.tests.fakes import FakeProcessRunner, model_call_on_run


def make_config(sandbox_root, **overrides):
    values = dict(
        pi_command="pi",
        model="fake-model",
        extension_path="/tmp/ext.js",
        endpoint_url="http://127.0.0.1:9",
        sandbox_root=str(sandbox_root),
        timeout_seconds=60,
    )
    values.update(overrides)
    return PiConfig(**values)


def make_task(**overrides):
    values = dict(
        task_id="task-001",
        prompt="copy hello.txt to done.txt",
        setup_files={"hello.txt": "hi\n"},
        environment={"TASK_ENV": "1"},
        checks=[{"type": "exit_code", "value": 0}],
    )
    values.update(overrides)
    return PiTask(**values)


class BuildPiCommandTests(unittest.TestCase):
    def test_argv_shape(self):
        config = make_config("/tmp/sandbox")
        argv = build_pi_command(config, "do the thing")
        self.assertEqual(argv, ["pi", "--model", "fake-model", "--extension", "/tmp/ext.js", "-p", "do the thing"])

    def test_prompt_is_passed_verbatim_as_a_single_argument(self):
        config = make_config("/tmp/sandbox")
        argv = build_pi_command(config, "line one\nline \"two\" $HOME")
        self.assertEqual(argv[-1], "line one\nline \"two\" $HOME")

    def test_invalid_config_is_rejected(self):
        with self.assertRaises(ValueError):
            build_pi_command(make_config("/tmp/sandbox", pi_command="  "), "prompt")


class BuildPiEnvTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-harness-test-")
        self.addCleanup(self._temporary.cleanup)
        self.ws = create_rollout_workspace(Path(self._temporary.name).resolve(), "task-001")

    def test_env_points_home_tmpdir_into_workspace(self):
        env = build_pi_env(make_config(self._temporary.name), self.ws, make_task())
        self.assertEqual(env["HOME"], os.path.join(self.ws.workspace, "home"))
        self.assertEqual(env["TMPDIR"], os.path.join(self.ws.workspace, "tmp"))

    def test_env_points_model_base_urls_at_the_endpoint(self):
        config = make_config(self._temporary.name, endpoint_url="http://proxy:1234")
        env = build_pi_env(config, self.ws, make_task())
        self.assertEqual(env["OPENAI_BASE_URL"], "http://proxy:1234")
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://proxy:1234")

    def test_env_prefers_the_interception_url_when_given(self):
        config = make_config(self._temporary.name, endpoint_url="http://upstream:1")
        env = build_pi_env(config, self.ws, make_task(), interception_url="http://127.0.0.1:7777")
        self.assertEqual(env["OPENAI_BASE_URL"], "http://127.0.0.1:7777")
        self.assertEqual(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:7777")

    def test_task_environment_is_merged_in(self):
        env = build_pi_env(make_config(self._temporary.name), self.ws, make_task())
        self.assertEqual(env["TASK_ENV"], "1")


class HarnessFailFastTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-harness-test-")
        self.addCleanup(self._temporary.cleanup)
        self.sandbox_root = Path(self._temporary.name).resolve()
        self.runner = FakeProcessRunner()

    def harness(self, config):
        return RolloutHarness(config, runner=self.runner, upstream=lambda request: {
            "choices": [{"message": {"role": "assistant", "content": "unused"}}],
        })

    def test_each_missing_config_field_fails_before_launch(self):
        for field in ("pi_command", "model", "extension_path", "endpoint_url", "sandbox_root"):
            with self.subTest(field=field):
                config = make_config(self.sandbox_root)
                setattr(config, field, "")
                with self.assertRaises(ValueError):
                    self.harness(config).run_task(make_task())
        self.assertEqual(self.runner.run_count, 0)
        self.assertEqual(list(self.sandbox_root.iterdir()), [], "no workspace may be created on fail-fast")

    def test_invalid_timeout_fails_before_launch(self):
        config = make_config(self.sandbox_root, timeout_seconds=0)
        with self.assertRaises(ValueError):
            self.harness(config).run_task(make_task())
        self.assertEqual(self.runner.run_count, 0)

    def test_invalid_task_fails_before_launch(self):
        config = make_config(self.sandbox_root)
        with self.assertRaises(ValueError):
            self.harness(config).run_task(make_task(checks=[]))
        with self.assertRaises(ValueError):
            self.harness(config).run_task(make_task(task_id="  "))
        self.assertEqual(self.runner.run_count, 0)
        self.assertEqual(list(self.sandbox_root.iterdir()), [])


class HarnessRunTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-harness-test-")
        self.addCleanup(self._temporary.cleanup)
        self.sandbox_root = Path(self._temporary.name).resolve()

    def harness(self, config, runner, upstream=None, **kwargs):
        return RolloutHarness(
            config,
            runner=runner,
            upstream=upstream or (lambda request: {
                "choices": [{"message": {"role": "assistant", "content": "final answer"}}],
            }),
            **kwargs,
        )

    def runner_with_model_call(self, result=None):
        """A fake Pi that runs AND makes one training call through the proxy."""
        return FakeProcessRunner(
            results=[result or RunResult(status="completed", exit_code=0, stdout="pi output\n", stderr="", timed_out=False)],
            on_run=model_call_on_run,
        )

    def test_rollout_happy_path_builds_valid_envelope(self):
        runner = self.runner_with_model_call()
        config = make_config(self.sandbox_root)
        outcome = self.harness(config, runner, use_proxy=True).run_task(make_task(
            checks=[{"type": "exit_code", "value": 0}, {"type": "file_exists", "path": "hello.txt"}],
        ))
        self.assertIsInstance(outcome, RolloutOutcome)
        self.assertEqual(outcome.response, "final answer")
        self.assertEqual(outcome.verification["verification"], "passed")
        self.assertEqual(outcome.failure_labels, [])
        self.assertEqual(validate_envelope(outcome.envelope), [])
        self.assertEqual(outcome.envelope["provenance"], {
            "session_id": "pi-task-001",
            "model": "fake-model",
            "provider": "external",
            "track": "raw",
            "attempt": 1,
        })
        self.assertEqual(outcome.envelope["task"]["prompt"], "copy hello.txt to done.txt")
        self.assertEqual(outcome.envelope["task"]["setup_files"], {"hello.txt": "hi\n"})
        self.assertEqual(outcome.envelope["task_id"], "task-001")
        self.assertEqual(len(outcome.trace), 1)
        self.assertEqual(outcome.aux_trace, [])

    def test_runner_receives_exactly_the_pi_argv_and_env(self):
        runner = FakeProcessRunner()  # Pi runs but the model never answers
        config = make_config(self.sandbox_root)
        task = make_task()
        with self.assertRaises(ValueError):
            self.harness(config, runner).run_task(task)
        self.assertEqual(runner.run_count, 1)
        call = runner.calls[0]
        self.assertEqual(call["argv"], build_pi_command(config, task.prompt))
        self.assertEqual(call["timeout"], config.timeout_seconds)
        self.assertEqual(call["env"]["OPENAI_BASE_URL"], config.endpoint_url)
        self.assertEqual(call["env"]["ANTHROPIC_BASE_URL"], config.endpoint_url)
        self.assertEqual(call["env"]["TASK_ENV"], "1")
        self.assertEqual(call["env"]["HOME"], os.path.join(call["cwd"], "home"))
        self.assertEqual(call["env"]["TMPDIR"], os.path.join(call["cwd"], "tmp"))
        self.assertEqual(Path(call["cwd"]).name, "workspace")

    def test_failed_pi_still_gets_verified_and_enveloped(self):
        runner = self.runner_with_model_call(result=RunResult(
            status="completed", exit_code=1, stdout="", stderr="nope", timed_out=False))
        config = make_config(self.sandbox_root)
        outcome = self.harness(config, runner, use_proxy=True).run_task(make_task(checks=[{"type": "exit_code", "value": 0}]))
        self.assertEqual(outcome.verification["verification"], "failed")
        self.assertEqual(outcome.verification["execution"]["exitCode"], 1)
        self.assertEqual(outcome.envelope["verification"], "failed")
        self.assertEqual(outcome.envelope["failureLabels"], ["functional"])
        self.assertEqual(validate_envelope(outcome.envelope), [])

    def test_timed_out_pi_still_gets_verified(self):
        runner = self.runner_with_model_call(result=RunResult(
            status="timed-out", exit_code=None, stdout="", stderr="killed", timed_out=True))
        config = make_config(self.sandbox_root)
        outcome = self.harness(config, runner, use_proxy=True).run_task(make_task(checks=[
            {"type": "file_exists", "path": "hello.txt"},  # setup file exists; check passes
        ]))
        self.assertEqual(outcome.verification["execution"]["status"], "timed-out")
        self.assertEqual(outcome.verification["verification"], "failed")
        self.assertEqual(outcome.envelope["failureLabels"], ["timeout"])
        self.assertEqual(validate_envelope(outcome.envelope), [])

    def test_workspace_is_cleaned_up_but_artifacts_survive(self):
        runner = self.runner_with_model_call()
        config = make_config(self.sandbox_root)
        outcome = self.harness(config, runner, use_proxy=True).run_task(make_task())
        self.assertFalse(Path(outcome.workspace_root).exists(), "rollout tree must be cleaned up")
        self.assertFalse(Path(outcome.trace_path).exists(), "in-rollout trace copy is gone with the tree")
        trace_text = Path(outcome.artifact_trace_path).read_text(encoding="utf-8")
        self.assertTrue(trace_text.strip(), "durable trace artifact must have content")
        envelope_text = Path(outcome.artifact_envelope_path).read_text(encoding="utf-8")
        self.assertEqual(validate_envelope(json.loads(envelope_text.strip())), [])

    def test_artifact_dir_override_is_honored(self):
        runner = self.runner_with_model_call()
        artifacts = self.sandbox_root / "elsewhere-artifacts"
        config = make_config(self.sandbox_root)
        outcome = self.harness(config, runner, use_proxy=True, artifact_dir=str(artifacts)).run_task(make_task())
        self.assertEqual(Path(outcome.artifact_trace_path).parent, artifacts)
        self.assertTrue(artifacts.is_dir())

    def test_no_training_call_is_a_hard_error(self):
        runner = FakeProcessRunner()  # never talks to the interception layer
        config = make_config(self.sandbox_root)
        with self.assertRaises(ValueError):
            self.harness(config, runner).run_task(make_task())
        self.assertEqual(runner.run_count, 1, "Pi itself still ran; the model simply never answered")


class EnvelopeGateTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-harness-test-")
        self.addCleanup(self._temporary.cleanup)
        self.config = make_config(Path(self._temporary.name).resolve())
        self.verification = {
            "verification": "passed",
            "execution": {"status": "passed", "exitCode": 0, "stdout": "", "stderr": ""},
            "failureLabels": [],
        }

    def test_built_row_passes_the_canonical_validator(self):
        row = build_envelope_row(make_task(), self.config, "an answer", self.verification)
        self.assertEqual(validate_envelope(row), [])
        self.assertEqual(row["content_hash"], row["content_hash"])  # shape sanity

    def test_tampered_row_is_caught_by_the_gate(self):
        row = build_envelope_row(make_task(), self.config, "an answer", self.verification)
        row["response"] = "tampered answer"
        problems = validate_envelope(row)
        self.assertTrue(problems, "gate must catch a tampered response")
        self.assertTrue(any("content_hash" in problem for problem in problems))

    def test_tampered_verification_is_a_validator_error(self):
        row = build_envelope_row(make_task(), self.config, "an answer", self.verification)
        row["verification"] = "maybe"
        self.assertTrue(validate_envelope(row))


class ResponseCaptureTests(unittest.TestCase):
    def test_extracts_openai_style_message_content(self):
        response = {"choices": [{"message": {"role": "assistant", "content": "hello there"}}]}
        self.assertEqual(extract_assistant_content(response), "hello there")

    def test_falls_back_to_legacy_text_field(self):
        self.assertEqual(extract_assistant_content({"choices": [{"text": "legacy"}]}), "legacy")

    def test_returns_empty_for_unusable_payloads(self):
        self.assertEqual(extract_assistant_content({}), "")
        self.assertEqual(extract_assistant_content({"choices": []}), "")
        self.assertEqual(extract_assistant_content(None), "")


class SplitTraceTests(unittest.TestCase):
    def test_training_and_auxiliary_are_split_in_order(self):
        entries = [
            {"call_type": TRAINING, "response": {"choices": [{"message": {"content": "one"}}]}},
            {"call_type": AUXILIARY, "response": {"choices": [{"message": {"content": "aux"}}]}},
            {"call_type": TRAINING, "response": {"choices": [{"message": {"content": "two"}}]}},
        ]
        training, aux = split_trace(entries)
        self.assertEqual([entry["response"]["choices"][0]["message"]["content"] for entry in training], ["one", "two"])
        self.assertEqual(len(aux), 1)
        self.assertEqual(aux[0]["call_type"], AUXILIARY)

    def test_empty_trace_splits_to_empty_lists(self):
        self.assertEqual(split_trace([]), ([], []))


if __name__ == "__main__":
    unittest.main()
