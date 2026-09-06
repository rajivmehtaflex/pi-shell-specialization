"""Rollout harness: one noninteractive Pi run, end to end.

``RolloutHarness.run_task`` orchestrates a single rollout:

  1. Fail fast: ``config.require_valid()`` + ``task.require_valid()`` before
     anything is launched.
  2. Create a rollout workspace (``sandbox.create_rollout_workspace``) and
     write the task's setup files; hidden verifier assets stay in the sibling
     ``verifier/`` directory, outside the candidate workspace.
  3. Build an ``InterceptionCore`` over the configured model upstream (the
     upstream callable is injectable; ``None`` uses ``runtime.default_upstream``).
     With ``use_proxy=True`` a loopback ``ProxyServer`` exposes the core and
     Pi's OpenAI-compatible base URL env points at it.
  4. Launch Pi noninteractively through the injectable process runner with
     ``build_pi_command``'s argv and ``build_pi_env``'s environment
     (cwd=workspace, HOME/TMPDIR inside the workspace, base-URL env vars,
     task environment). The runner kills the child on timeout.
  5. Serialize the training trace (auxiliary Pi calls excluded; they are kept
     on the outcome's ``aux_trace`` side list) as JSONL to the rollout trace
     path and to a durable artifact directory that survives cleanup.
  6. Run the hidden verifier AFTER Pi exits -- always, even when Pi failed or
     timed out.
  7. Capture the response: the content of the LAST training call's response
     (documented, deterministic; auxiliary calls never contribute).
  8. Build the canonical envelope row and gate it through
     ``workers.contracts.validate_envelope`` -- an invalid row raises.
  9. Clean up the rollout tree in ``finally``; durable artifacts survive.

No GPU work and no subprocess other than the single Pi launch happens here;
tests inject ``FakeProcessRunner``-style runners and lambda upstreams.
"""

from __future__ import annotations

import inspect
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

from .config import PiConfig
from .interception import AUXILIARY, TRAINING, InterceptionCore, ProxyServer
from .sandbox import cleanup_workspace, create_rollout_workspace, write_setup_files
from .task import PiTask
from .verifier import run_verifier
from workers.contracts import compute_record_hash, validate_envelope

EXTENSION_FLAG = "--extension"
MODEL_FLAG = "--model"
PROMPT_FLAG = "-p"  # noninteractive prompt; long form: --prompt
ARTIFACTS_DIRNAME = "artifacts"


@dataclass
class RolloutOutcome:
    """Everything one rollout produced, plus durable artifact paths."""

    task_id: str
    response: str
    trace: list[dict] = field(default_factory=list)  # training calls only
    verification: dict = field(default_factory=dict)
    envelope: dict = field(default_factory=dict)
    aux_trace: list[dict] = field(default_factory=list)  # auxiliary calls, excluded from the training trace
    workspace_root: str = ""
    workspace: str = ""
    verifier_dir: str = ""
    trace_path: str = ""  # inside the rollout root (removed by cleanup)
    artifact_trace_path: str = ""  # durable copy that survives cleanup
    artifact_envelope_path: str = ""  # durable envelope row (JSONL)

    @property
    def failure_labels(self) -> list[str]:
        return list(self.verification.get("failureLabels", []))


def build_pi_command(config: PiConfig, prompt: str) -> list[str]:
    """Stable noninteractive Pi argv: model, extension, then ``-p <prompt>``."""
    config.require_valid()
    return [
        config.pi_command,
        MODEL_FLAG,
        config.model,
        EXTENSION_FLAG,
        config.extension_path,
        PROMPT_FLAG,
        prompt,
    ]


def build_pi_env(config: PiConfig, ws, task: PiTask, interception_url: str | None = None) -> dict:
    """Environment for the Pi child process.

    HOME/TMPDIR are confined to the workspace, both OpenAI- and
    Anthropic-compatible base URL variables point at the interception layer
    (defaulting to the configured endpoint when no proxy is started), and the
    task environment is merged on top of the parent environment.
    """
    env = dict(os.environ)
    env["HOME"] = os.path.join(ws.workspace, "home")
    env["TMPDIR"] = os.path.join(ws.workspace, "tmp")
    url = interception_url if interception_url else config.endpoint_url
    env["OPENAI_BASE_URL"] = url
    env["ANTHROPIC_BASE_URL"] = url
    for key, value in task.environment.items():
        env[str(key)] = str(value)
    return env


def extract_assistant_content(response: Any) -> str:
    """Final assistant/chat content from an OpenAI-compatible response body."""
    if not isinstance(response, dict):
        return ""
    choices = response.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"]
        if isinstance(choices[0].get("text"), str):
            return choices[0]["text"]
    content = response.get("content")
    return content if isinstance(content, str) else ""


def trace_entry(call, captured: dict | None) -> dict:
    """One JSONL trace entry: interception metadata plus the full bodies."""
    entry = {
        "call_type": call.call_type,
        "request_metadata": dict(call.request_metadata),
        "response_metadata": dict(call.response_metadata),
    }
    if captured is not None:
        entry["request"] = captured["request"]
        entry["response"] = captured["response"]
    return entry


def split_trace(entries: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split ordered trace entries into (training, auxiliary) lists."""
    training = [entry for entry in entries if entry.get("call_type") == TRAINING]
    auxiliary = [entry for entry in entries if entry.get("call_type") == AUXILIARY]
    return training, auxiliary


def append_trace_entries(entries: list[dict], path: str | Path) -> None:
    """Append entries as JSONL, same serialization as InterceptionCore.append_trace."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, sort_keys=True) + "\n")


def build_envelope_row(task: PiTask, config: PiConfig, response: str, verification: dict) -> dict:
    """Canonical verified-data envelope row for one rollout."""
    row = {
        "task_id": task.task_id,
        "task": {
            "prompt": task.prompt,
            "setup_files": dict(task.setup_files),
            "environment": dict(task.environment),
            "checks": [dict(check) for check in task.checks],
        },
        "response": response,
        "verification": verification["verification"],
        "execution": dict(verification["execution"]),
        "failureLabels": list(verification["failureLabels"]),
        "provenance": {
            "session_id": f"pi-{task.task_id}",
            "model": config.model,
            "provider": "external",
            "track": "raw",
            "attempt": 1,
        },
    }
    row["content_hash"] = compute_record_hash(row)
    return row


class _CapturingUpstream:
    """Wraps the raw model transport, recording full request/response bodies."""

    def __init__(self, transport: Callable[[dict], dict]):
        self._transport = transport
        self.records: list[dict] = []

    def __call__(self, request: dict) -> dict:
        response = self._transport(request)
        self.records.append({"request": request, "response": response})
        return response


def _resolve_transport(upstream: Any, config: PiConfig) -> Callable[[dict], dict]:
    """Normalize the injectable upstream into a raw ``request -> response`` transport.

    Accepted forms: ``None`` (use ``runtime.default_upstream``), a callable
    taking the request dict, or a zero-argument factory returning an
    ``InterceptionCore`` (only its underlying transport is reused, since the
    core itself is rebuilt fresh per rollout).
    """
    if upstream is None:
        from .runtime import default_upstream  # local import avoids a cycle

        return default_upstream(config.endpoint_url)
    if not callable(upstream):
        raise ValueError("upstream must be None, a callable(request) -> response, or a zero-arg InterceptionCore factory")
    try:
        parameters = inspect.signature(upstream).parameters.values()
        required = [
            parameter
            for parameter in parameters
            if parameter.default is inspect.Parameter.empty
            and parameter.kind
            in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
                inspect.Parameter.KEYWORD_ONLY,
            )
        ]
    except (TypeError, ValueError):  # exotic callables: treat as request-taking
        required = ["unknown"]
    if required:
        return upstream
    core = upstream()
    transport = getattr(core, "_upstream", None)
    if not callable(transport):
        raise ValueError("upstream factory must return an InterceptionCore")
    return transport


def _to_snapshot(result: Any) -> dict:
    """Normalize a runner result into an execution snapshot mapping."""
    to_execution = getattr(result, "to_execution", None)
    if callable(to_execution):
        return to_execution()
    if isinstance(result, Mapping):
        return dict(result)
    raise ValueError("runner result must expose to_execution() or be a mapping")


class RolloutHarness:
    """Runs one Pi rollout per ``run_task`` call with injectable seams."""

    def __init__(
        self,
        config: PiConfig,
        runner=None,
        upstream: Any = None,
        use_proxy: bool = False,
        artifact_dir: str | None = None,
    ):
        self.config = config
        if runner is None:
            from .runtime import SubprocessRunner  # local import avoids a cycle

            runner = SubprocessRunner()
        self.runner = runner
        self._upstream = upstream
        self.use_proxy = use_proxy
        self.artifact_dir = artifact_dir

    def run_task(self, task: PiTask) -> RolloutOutcome:
        """Execute the full rollout pipeline and return the outcome.

        Raises ValueError on misconfiguration (before any launch), when the
        model produced no training-call response, or when the envelope gate
        rejects the built row. The rollout tree is always cleaned up.
        """
        # 1. Fail fast BEFORE any launch.
        self.config.require_valid()
        task.require_valid()

        # 2. Fresh isolated workspace; setup files land in the workspace, the
        #    hidden verifier stays in the sibling verifier/ directory.
        ws = create_rollout_workspace(self.config.sandbox_root, task.task_id)
        proxy = None
        try:
            write_setup_files(ws, task.setup_files)

            # 3. Interception core over the configured upstream.
            capture = _CapturingUpstream(_resolve_transport(self._upstream, self.config))
            core = InterceptionCore(capture)
            interception_url = self.config.endpoint_url
            if self.use_proxy:
                proxy = ProxyServer(core)
                proxy.start()
                interception_url = proxy.base_url

            # 4. Launch Pi noninteractively through the runner.
            argv = build_pi_command(self.config, task.prompt)
            env = build_pi_env(self.config, ws, task, interception_url=interception_url)
            run = self.runner.run(argv, cwd=ws.workspace, env=env, timeout=self.config.timeout_seconds)

            # 5. Training trace (aux calls filtered out, kept on the side list).
            entries = [
                trace_entry(call, capture.records[index] if index < len(capture.records) else None)
                for index, call in enumerate(core.calls)
            ]
            training, aux = split_trace(entries)
            append_trace_entries(training, ws.trace_path)

            # 6. Hidden verifier runs AFTER Pi exits -- always.
            verification = run_verifier(ws, task, _to_snapshot(run))

            # 7. Response: last training call's assistant content.
            response = extract_assistant_content(training[-1]["response"]) if training else ""
            if not response.strip():
                raise ValueError(
                    f"no training-call response captured for task {task.task_id!r}; cannot build a valid envelope row"
                )

            # 8. Canonical envelope row, gated by the canonical validator.
            envelope = build_envelope_row(task, self.config, response, verification)
            problems = validate_envelope(envelope)
            if problems:
                raise ValueError("envelope gate rejected the rollout row: " + "; ".join(problems))

            artifact_trace, artifact_envelope = self._write_artifacts(ws, training, envelope)

            return RolloutOutcome(
                task_id=task.task_id,
                response=response,
                trace=training,
                verification=verification,
                envelope=envelope,
                aux_trace=aux,
                workspace_root=ws.root,
                workspace=ws.workspace,
                verifier_dir=ws.verifier,
                trace_path=ws.trace_path,
                artifact_trace_path=artifact_trace,
                artifact_envelope_path=artifact_envelope,
            )
        finally:
            # 9. Cleanup always runs; durable artifacts live outside the tree.
            if proxy is not None:
                proxy.stop()
            cleanup_workspace(ws)

    def _write_artifacts(self, ws, training: list[dict], envelope: dict) -> tuple[str, str]:
        """Persist the training trace and envelope row outside the rollout tree."""
        artifact_dir = Path(self.artifact_dir) if self.artifact_dir else Path(self.config.sandbox_root) / ARTIFACTS_DIRNAME
        artifact_dir.mkdir(parents=True, exist_ok=True)
        stem = Path(ws.root).name
        trace_path = artifact_dir / f"{stem}.trace.jsonl"
        envelope_path = artifact_dir / f"{stem}.envelope.jsonl"
        append_trace_entries(training, trace_path)
        envelope_path.write_text(json.dumps(envelope, sort_keys=True) + "\n", encoding="utf-8")
        return str(trace_path), str(envelope_path)
