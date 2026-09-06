"""Real-executor glue for Pi rollouts.

This module owns everything that actually touches the host:

  * ``RunResult``/``SubprocessRunner`` -- the subprocess execution style of
    ``workers/verify.py`` (``capture_output=True, text=True, timeout=...``)
    adapted to launching Pi noninteractively; a timeout kills the child and is
    reported as ``status="timed-out"``.
  * ``load_config`` -- ``PiConfig.from_env`` + ``require_valid`` so a phase
    script fails fast on misconfiguration.
  * ``default_upstream`` -- a minimal urllib-based JSON POST forwarder used as
    the model transport underneath the interception layer.
  * ``run_rollout`` -- the one-call entry point Wave-3 phase scripts wire into:
    ``run_rollout(task) -> envelope row dict``.
"""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping

from .config import PiConfig
from .interception import DEFAULT_ENDPOINT_PATH

# Mirror workers/verify.py: captured streams are truncated to 64 KiB.
MAX_CAPTURE_BYTES = 65536
DEFAULT_UPSTREAM_TIMEOUT_SECONDS = 120.0


def _as_text(value: Any) -> str:
    """TimeoutExpired hands back bytes even under text=True; normalize."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


@dataclass
class RunResult:
    """Outcome of one child-process run."""

    status: str  # "completed" | "timed-out" | "error"
    exit_code: int | None
    stdout: str
    stderr: str
    timed_out: bool = False

    def to_execution(self) -> dict:
        """Envelope-vocabulary execution snapshot (exitCode camelCase)."""
        return {
            "status": self.status,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
        }


class SubprocessRunner:
    """Blocking subprocess runner; kills the child when ``timeout`` expires."""

    def run(self, argv, cwd, env, timeout) -> RunResult:
        try:
            completed = subprocess.run(
                [str(argument) for argument in argv],
                cwd=cwd,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            stderr = _as_text(error.stderr) or f"timed out after {timeout} seconds and was killed"
            return RunResult(
                status="timed-out",
                exit_code=None,
                stdout=_as_text(error.stdout)[:MAX_CAPTURE_BYTES],
                stderr=stderr[:MAX_CAPTURE_BYTES],
                timed_out=True,
            )
        except (OSError, ValueError) as error:
            return RunResult(status="error", exit_code=None, stdout="", stderr=str(error)[:MAX_CAPTURE_BYTES])
        return RunResult(
            status="completed",
            exit_code=completed.returncode,
            stdout=completed.stdout[:MAX_CAPTURE_BYTES],
            stderr=completed.stderr[:MAX_CAPTURE_BYTES],
        )


def load_config(env: Mapping[str, str] | None = None) -> PiConfig:
    """Build the PiConfig from PI_* variables and require it to be valid."""
    config = PiConfig.from_env(env if env is not None else os.environ)
    config.require_valid()
    return config


def completions_url(endpoint_url: str) -> str:
    """Resolve the chat-completions URL for a configured base endpoint."""
    base = str(endpoint_url).rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    return base + DEFAULT_ENDPOINT_PATH


def default_upstream(endpoint_url: str, timeout_seconds: float = DEFAULT_UPSTREAM_TIMEOUT_SECONDS):
    """Minimal urllib POST forwarder: request dict in, parsed JSON out."""
    url = completions_url(endpoint_url)

    def upstream(request: dict) -> dict:
        if not isinstance(request, dict):
            raise ValueError("upstream request must be a JSON object")
        body = json.dumps(request).encode("utf-8")
        http_request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(http_request, timeout=timeout_seconds) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.URLError as error:
            raise RuntimeError(f"model endpoint {url} failed: {error}") from error
        try:
            return json.loads(payload)
        except ValueError as error:
            raise RuntimeError(f"model endpoint {url} returned non-JSON: {error}") from error

    return upstream


def run_rollout(
    task,
    config: PiConfig | None = None,
    runner=None,
    upstream=None,
    use_proxy: bool = True,
    artifact_dir: str | None = None,
) -> dict:
    """Run one full Pi rollout and return the canonical envelope row.

    Wave-3 entry point: ``run_rollout(task)`` loads the config from the
    environment, launches Pi noninteractively through the interception layer,
    verifies the workspace afterwards, and returns a row satisfying
    ``workers.contracts.validate_envelope(row) == []``.
    """
    from .harness import RolloutHarness  # local import: harness lazy-imports runtime

    if config is None:
        config = load_config()
    harness = RolloutHarness(
        config,
        runner=runner,
        upstream=upstream,
        use_proxy=use_proxy,
        artifact_dir=artifact_dir,
    )
    return harness.run_task(task).envelope
