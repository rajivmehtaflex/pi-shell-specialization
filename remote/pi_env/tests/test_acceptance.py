"""Acceptance gate: one full fake Pi rollout through the real harness.

Everything is in-process: Pi "runs" via FakeProcessRunner (no subprocess, no
GPU), the interception layer is a real loopback ProxyServer over a fake
upstream lambda. The test proves:

  * the rollout workspace is isolated (hidden verifier dir outside workspace),
  * the Pi argv/env given to the runner is exactly the harness contract,
  * interception records training calls and filters auxiliary ones,
  * the training trace JSONL is written and durably preserved as an artifact,
  * the response is captured from the last training call,
  * the hidden verifier runs after Pi exits (passing and failing scenarios),
  * the envelope row satisfies validate_envelope() == [],
  * no training happens: the only "process" ever launched is the fake runner
    receiving exactly one argv (nothing else is spawned).
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from remote.pi_env.harness import RolloutHarness, build_pi_command
from remote.pi_env.runtime import RunResult
from remote.pi_env.task import PiTask
from workers.contracts import validate_envelope

from remote.pi_env.tests.fakes import FakeProcessRunner, post_json


def upstream_lambda(request):
    """Fake model endpoint: distinct content for the task turn vs aux turns."""
    messages = request.get("messages") if isinstance(request, dict) else []
    text = ""
    if messages and isinstance(messages[-1], dict):
        text = str(messages[-1].get("content", ""))
    content = "AUX-SUMMARY" if "summarize" in text else "final answer: 42"
    return {"model": "fake-model", "choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}


def fake_pi_behaviour(argv, cwd, env, timeout):
    """What a real noninteractive Pi run would do, staged in-process."""
    # Pi works in its cwd (the candidate workspace) and produces a file.
    created = Path(cwd) / "created"
    created.mkdir(exist_ok=True)
    (created / "by-pi.txt").write_text("pi was here\n", encoding="utf-8")
    # A runaway stage would try to peek at the sibling verifier dir; the fake
    # plants a decoy there that file checks must NEVER see.
    verifier_dir = Path(cwd).parent / "verifier"
    (verifier_dir / "verifier-answer.txt").write_text("leaked answers", encoding="utf-8")
    # Pi talks OpenAI-compatible: one training turn, one auxiliary call.
    training = post_json(env["OPENAI_BASE_URL"] + "/v1/chat/completions", {
        "model": "fake-model",
        "messages": [{"role": "user", "content": "solve the shell task"}],
    })
    auxiliary = post_json(env["OPENAI_BASE_URL"] + "/v1/chat/completions", {
        "model": "fake-model",
        "messages": [{"role": "user", "content": "summarize the session"}],
    }, headers={"X-Pi-Call-Type": "auxiliary"})
    assert training["choices"][0]["message"]["content"] == "final answer: 42"
    assert auxiliary["choices"][0]["message"]["content"] == "AUX-SUMMARY"
    return training


def make_config(sandbox_root):
    from remote.pi_env.config import PiConfig

    return PiConfig(
        pi_command="pi",
        model="fake-model",
        extension_path="/tmp/ext.js",
        endpoint_url="http://127.0.0.1:9/unreachable",
        sandbox_root=str(sandbox_root),
        timeout_seconds=60,
    )


class AcceptanceGateTests(unittest.TestCase):
    def setUp(self):
        self._temporary = tempfile.TemporaryDirectory(prefix="pi-env-acceptance-")
        self.addCleanup(self._temporary.cleanup)
        self.sandbox_root = Path(self._temporary.name).resolve()

    def _run(self, task, runner_result=None):
        config = make_config(self.sandbox_root)
        runner = FakeProcessRunner(
            results=[runner_result or RunResult(status="completed", exit_code=0, stdout="pi done\n", stderr="", timed_out=False)],
            on_run=fake_pi_behaviour,
        )
        harness = RolloutHarness(config, runner=runner, upstream=upstream_lambda, use_proxy=True)
        return harness.run_task(task), runner, config

    def test_full_fake_rollout_passes_the_gate(self):
        task = PiTask(
            task_id="acceptance-001",
            prompt="create created/by-pi.txt",
            setup_files={"input.txt": "seed content\n"},
            environment={"ACCEPTANCE": "1"},
            checks=[
                {"type": "file_exists", "path": "created/by-pi.txt"},
                {"type": "file_contains", "path": "input.txt", "value": "seed content"},
                {"type": "stdout_contains", "value": "pi done"},
                {"type": "exit_code", "value": 0},
                {"type": "file_exists", "path": "verifier-answer.txt", "absent": True},
            ],
        )
        outcome, runner, config = self._run(task)

        # 1. Pi ran exactly once with exactly the contractual argv -- nothing
        #    else was ever spawned (upstream + interception are in-process).
        self.assertEqual(runner.run_count, 1)
        self.assertEqual(runner.calls[0]["argv"], build_pi_command(config, task.prompt))
        self.assertEqual(runner.calls[0]["cwd"], outcome.workspace)
        self.assertEqual(runner.calls[0]["env"]["HOME"], os.path.join(outcome.workspace, "home"))
        self.assertEqual(runner.calls[0]["env"]["TMPDIR"], os.path.join(outcome.workspace, "tmp"))
        self.assertEqual(runner.calls[0]["env"]["ACCEPTANCE"], "1")
        self.assertTrue(runner.calls[0]["env"]["OPENAI_BASE_URL"].startswith("http://127.0.0.1:"),
                        "Pi's base URL must point at the interception layer, not the endpoint")

        # 2. Workspace isolation: verifier dir is a sibling, never inside workspace.
        self.assertNotIn(str(Path(outcome.workspace).resolve()) + os.sep,
                         str(Path(outcome.verifier_dir).resolve()))

        # 3. Interception recorded >=1 training call and filtered the aux call.
        self.assertGreaterEqual(len(outcome.trace), 1)
        self.assertTrue(all(entry["call_type"] == "training" for entry in outcome.trace))
        self.assertEqual(len(outcome.aux_trace), 1)
        self.assertEqual(outcome.aux_trace[0]["call_type"], "auxiliary")

        # 4. Response captured from the last training call (not the aux call,
        #    which arrived last on the wire).
        self.assertEqual(outcome.response, "final answer: 42")
        self.assertNotIn("AUX-SUMMARY", outcome.response)

        # 5. Durable training trace artifact on disk with real content; the
        #    rollout tree (including the in-rollout trace copy) is cleaned up.
        self.assertFalse(Path(outcome.workspace_root).exists())
        durable = Path(outcome.artifact_trace_path)
        self.assertTrue(durable.exists())
        lines = [line for line in durable.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertGreaterEqual(len(lines), 1)
        entries = [json.loads(line) for line in lines]
        self.assertTrue(all(entry["call_type"] == "training" for entry in entries))
        serialized = json.dumps(entries)
        self.assertIn("final answer: 42", serialized)
        self.assertNotIn("AUX-SUMMARY", serialized)

        # 6. Verifier ran after Pi exited and passed every check -- including
        #    the absent-check proving the verifier dir stayed invisible.
        self.assertEqual(outcome.verification["verification"], "passed")
        self.assertEqual(outcome.verification["execution"]["status"], "passed")
        self.assertEqual(outcome.verification["failureLabels"], [])

        # 7. The envelope row is canonical.
        self.assertEqual(validate_envelope(outcome.envelope), [])
        self.assertEqual(outcome.envelope["response"], "final answer: 42")
        self.assertEqual(outcome.envelope["provenance"]["session_id"], "pi-acceptance-001")

        # 8. The envelope itself is a durable artifact too.
        envelope_artifact = Path(outcome.artifact_envelope_path)
        self.assertTrue(envelope_artifact.exists())
        self.assertEqual(validate_envelope(json.loads(envelope_artifact.read_text(encoding="utf-8").strip())), [])

    def test_full_fake_rollout_failing_checks_still_envelopes(self):
        task = PiTask(
            task_id="acceptance-002",
            prompt="this task's checks will fail",
            checks=[{"type": "file_contains", "path": "input.txt", "value": "expected content"}],
        )
        outcome, runner, _ = self._run(task)
        self.assertEqual(runner.run_count, 1)
        self.assertEqual(outcome.verification["verification"], "failed")
        self.assertEqual(outcome.verification["failureLabels"], ["functional"])
        self.assertEqual(outcome.envelope["verification"], "failed")
        self.assertEqual(outcome.envelope["failureLabels"], ["functional"])
        self.assertEqual(validate_envelope(outcome.envelope), [])
        self.assertTrue(Path(outcome.artifact_trace_path).exists())

    def test_timed_out_rollout_still_writes_trace_verifier_and_envelope(self):
        task = PiTask(task_id="acceptance-003", prompt="hang forever", checks=[
            {"type": "file_exists", "path": "created/by-pi.txt"},
        ])
        outcome, runner, _ = self._run(task, runner_result=RunResult(
            status="timed-out", exit_code=None, stdout="", stderr="killed after timeout", timed_out=True))
        self.assertEqual(runner.run_count, 1)
        self.assertEqual(outcome.verification["execution"]["status"], "timed-out")
        self.assertEqual(outcome.envelope["failureLabels"], ["timeout"])
        self.assertEqual(validate_envelope(outcome.envelope), [])
        self.assertTrue(Path(outcome.artifact_trace_path).exists())


if __name__ == "__main__":
    unittest.main()
