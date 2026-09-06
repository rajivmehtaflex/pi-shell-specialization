"""Shared deterministic fakes for remote/pi_env tests.

``FakeProcessRunner`` stands in for the real ``SubprocessRunner`` so no Pi
process (and no GPU work) ever launches during tests. An optional ``on_run``
hook lets a test simulate what a real Pi process would do (write files into
its cwd, POST chat completions to the interception proxy) at the exact moment
the process would run.
"""

from __future__ import annotations

import json
import urllib.request

from remote.pi_env.runtime import RunResult


def post_json(url: str, payload: dict, headers: dict | None = None, timeout: float = 10) -> dict:
    """POST one JSON payload (the way a real Pi would hit the proxy)."""
    body = json.dumps(payload).encode("utf-8")
    merged = {"Content-Type": "application/json"}
    merged.update(headers or {})
    request = urllib.request.Request(url, data=body, headers=merged, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def model_call_on_run(argv, cwd, env, timeout):
    """on_run hook: simulate Pi making one training call to the interception proxy."""
    return post_json(env["OPENAI_BASE_URL"] + "/v1/chat/completions", {
        "model": "fake-model",
        "messages": [{"role": "user", "content": "do the task"}],
    })


class FakeProcessRunner:
    """Scripted process runner: records every run() call, returns scripted results."""

    def __init__(self, results=None, on_run=None):
        self.calls: list[dict] = []
        self._results = list(results or [])
        self._on_run = on_run

    def run(self, argv, cwd, env, timeout):
        self.calls.append({"argv": list(argv), "cwd": cwd, "env": dict(env), "timeout": timeout})
        if self._on_run is not None:
            self._on_run(argv, cwd, env, timeout)
        if self._results:
            return self._results.pop(0)
        return RunResult(status="completed", exit_code=0, stdout="", stderr="", timed_out=False)

    @property
    def run_count(self) -> int:
        return len(self.calls)
