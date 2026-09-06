"""Pi launcher configuration.

``PiConfig`` carries everything needed to launch one Pi rollout against the
OpenAI-compatible interception proxy. ``from_env`` builds it from the
``PI_*`` environment variables with sane defaults so misconfiguration is
detectable via ``validate``/``require_valid`` before any process is spawned.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

DEFAULT_TIMEOUT_SECONDS = 900

_STRING_FIELDS = ("pi_command", "model", "extension_path", "endpoint_url", "sandbox_root")

_ENV_VARS = {
    "pi_command": "PI_COMMAND",
    "model": "PI_MODEL",
    "extension_path": "PI_EXTENSION_PATH",
    "endpoint_url": "PI_ENDPOINT_URL",
    "sandbox_root": "PI_SANDBOX_ROOT",
}


@dataclass
class PiConfig:
    """Settings for one noninteractive Pi rollout."""

    pi_command: str = ""
    model: str = ""
    extension_path: str = ""
    endpoint_url: str = ""
    sandbox_root: str = ""
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS

    def validate(self) -> list[str]:
        """Return a list of human-readable problems; an empty list means valid."""
        problems: list[str] = []
        for name in _STRING_FIELDS:
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                problems.append(f"{name} must be a non-empty string")
        timeout = self.timeout_seconds
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1:
            problems.append("timeout_seconds must be an integer >= 1")
        return problems

    def require_valid(self) -> None:
        """Raise ValueError listing every problem when the config is invalid."""
        problems = self.validate()
        if problems:
            raise ValueError("invalid PiConfig: " + "; ".join(problems))

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "PiConfig":
        """Read PI_COMMAND/PI_MODEL/PI_EXTENSION_PATH/PI_ENDPOINT_URL/PI_SANDBOX_ROOT/PI_TIMEOUT_SECONDS.

        Missing string variables default to "" (flagged later by ``validate``).
        A missing or blank PI_TIMEOUT_SECONDS defaults to DEFAULT_TIMEOUT_SECONDS;
        an unparsable value is preserved as-is so ``validate`` flags it.
        """
        values = {name: str(env.get(var, "")) for name, var in _ENV_VARS.items()}
        raw_timeout = str(env.get("PI_TIMEOUT_SECONDS", "")).strip()
        if not raw_timeout:
            timeout: object = DEFAULT_TIMEOUT_SECONDS
        else:
            try:
                timeout = int(raw_timeout)
            except ValueError:
                timeout = raw_timeout
        return cls(**values, timeout_seconds=timeout)  # type: ignore[arg-type]
