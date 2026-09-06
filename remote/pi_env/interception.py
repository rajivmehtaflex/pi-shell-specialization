"""OpenAI-compatible interception layer for Pi rollouts.

``InterceptionCore`` is the pure logic: it forwards each chat-completion
request to an injectable ``upstream`` callable (the real model endpoint in
production, a fake in tests), records every request/response pair, and
classifies each call as a training turn or an auxiliary Pi call.

Classification (``classify_call``):
  * headers containing ``X-Pi-Call-Type: auxiliary`` (case-insensitive), or
  * request body ``{"metadata": {"pi_call": "auxiliary"}}``,
mark the call auxiliary; everything else is a training turn.

``ProxyServer`` is a thin ``http.server`` seam so a later wave can point Pi's
OpenAI-compatible base URL at a real local socket without changing the core.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

TRAINING = "training"
AUXILIARY = "auxiliary"

AUX_HEADER_NAME = "x-pi-call-type"
AUX_PATH_HEADER_NAME = "x-pi-path"
DEFAULT_ENDPOINT_PATH = "/v1/chat/completions"

Upstream = Callable[[dict], dict]


def _header_value(headers: dict | None, name: str) -> str | None:
    """Case-insensitive header lookup returning the stripped value, if present."""
    if not headers:
        return None
    wanted = name.lower()
    for key, value in headers.items():
        if str(key).lower() == wanted:
            return str(value).strip().lower()
    return None


def classify_call(request: dict, headers: dict | None = None) -> str:
    """Classify one request as AUXILIARY or TRAINING."""
    header = _header_value(headers, AUX_HEADER_NAME)
    if header == AUXILIARY:
        return AUXILIARY
    metadata = request.get("metadata") if isinstance(request, dict) else None
    if isinstance(metadata, dict) and str(metadata.get("pi_call", "")).strip().lower() == AUXILIARY:
        return AUXILIARY
    return TRAINING


def _request_metadata(request: dict, headers: dict | None, started_at: float, aux_source: str | None) -> dict:
    messages = request.get("messages") if isinstance(request, dict) else None
    messages = messages if isinstance(messages, list) else []
    tool_turns = sum(1 for message in messages if isinstance(message, dict) and message.get("role") == "tool")
    metadata: dict[str, Any] = {
        "model": request.get("model") if isinstance(request, dict) else None,
        "path": _header_value(headers, AUX_PATH_HEADER_NAME) or DEFAULT_ENDPOINT_PATH,
        "started_at": started_at,
        "completed_at": time.time(),
        "message_turns": len(messages),
        "tool_turns": tool_turns,
    }
    if aux_source:
        metadata["aux_source"] = aux_source
    return metadata


def _response_metadata(response: dict) -> dict:
    response = response if isinstance(response, dict) else {}
    choices = response.get("choices") if isinstance(response.get("choices"), list) else []
    finish_reason = None
    if choices and isinstance(choices[0], dict):
        finish_reason = choices[0].get("finish_reason")
    return {
        "model": response.get("model"),
        "status": "ok",
        "choice_count": len(choices),
        "finish_reason": finish_reason,
    }


@dataclass
class InterceptedCall:
    """One captured model call with its classification and metadata."""

    request_metadata: dict = field(default_factory=dict)
    response_metadata: dict = field(default_factory=dict)
    call_type: str = TRAINING


class InterceptionCore:
    """Records model calls through an injectable upstream transport."""

    def __init__(self, upstream: Upstream, clock: Callable[[], float] = time.time):
        if not callable(upstream):
            raise ValueError("upstream must be a callable(request) -> response")
        self._upstream = upstream
        self._clock = clock
        self._calls: list[InterceptedCall] = []
        self._lock = threading.Lock()

    @property
    def calls(self) -> list[InterceptedCall]:
        """A snapshot copy of the recorded calls, in order."""
        with self._lock:
            return list(self._calls)

    def handle(self, request: dict, headers: dict | None = None) -> dict:
        """Forward ``request`` to upstream, record the call, return the response."""
        started_at = self._clock()
        response = self._upstream(request)
        call_type = classify_call(request, headers)
        aux_source = None
        if call_type == AUXILIARY:
            aux_source = "header" if _header_value(headers, AUX_HEADER_NAME) == AUXILIARY else "body-metadata"
        call = InterceptedCall(
            request_metadata=_request_metadata(request, headers, started_at, aux_source),
            response_metadata=_response_metadata(response),
            call_type=call_type,
        )
        with self._lock:
            self._calls.append(call)
        return response

    def _calls_of_type(self, call_type: str) -> list[InterceptedCall]:
        return [call for call in self.calls if call.call_type == call_type]

    def training_calls(self) -> list[InterceptedCall]:
        """Recorded training turns (auxiliary calls filtered out)."""
        return self._calls_of_type(TRAINING)

    def aux_calls(self) -> list[InterceptedCall]:
        """Recorded auxiliary Pi calls."""
        return self._calls_of_type(AUXILIARY)

    def trace(self) -> list[dict]:
        """Serialize all recorded calls, in order, as plain dicts."""
        return [
            {
                "call_type": call.call_type,
                "request_metadata": dict(call.request_metadata),
                "response_metadata": dict(call.response_metadata),
            }
            for call in self.calls
        ]

    def append_trace(self, path: str | Path) -> None:
        """Append the trace as JSONL (one JSON object per line), in order."""
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as handle:
            for entry in self.trace():
                handle.write(json.dumps(entry, sort_keys=True) + "\n")


class ProxyServer:
    """Thin ThreadingHTTPServer seam exposing an InterceptionCore on loopback.

    Kept deliberately minimal: POST a JSON chat-completion body to any path;
    the JSON response of the core's upstream comes back. Kept out of the
    pure-logic unit tests except for a single loopback smoke test.
    """

    def __init__(self, core: InterceptionCore, host: str = "127.0.0.1", port: int = 0):
        self.core = core
        self._host = host
        core_ref = core

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 (http.server API)
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    request = json.loads(self.rfile.read(length).decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as error:
                    self._respond(400, {"error": f"invalid JSON request: {error}"})
                    return
                try:
                    response = core_ref.handle(request, headers=dict(self.headers))
                except Exception as error:  # noqa: BLE001 - seam must not crash the server
                    self._respond(502, {"error": str(error)})
                    return
                self._respond(200, response)

            def _respond(self, status: int, payload: dict) -> None:
                body = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

        self._server = ThreadingHTTPServer((host, port), Handler)
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return self._server.server_address[1]

    @property
    def base_url(self) -> str:
        return f"http://{self._host}:{self.port}"

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    def post(self, path: str, request: dict, headers: dict | None = None) -> dict:
        """Blocking test helper: POST one JSON request to this server."""
        import urllib.error
        import urllib.request

        body = json.dumps(request).encode("utf-8")
        merged = {"Content-Type": "application/json"}
        merged.update(headers or {})
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, data=body, headers=merged, method="POST")
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    def __enter__(self) -> "ProxyServer":
        self.start()
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.stop()
