"""Task payload for one Pi rollout.

``PiTask`` mirrors the benchmark task vocabulary already used by
``workers/verify.py`` (setupFiles/paths/checks), but with pythonic snake_case
field names and eager validation so a malformed task is rejected before any
sandbox or verifier runs. The six supported check types are exactly the ones
handled by ``workers/verify.py::_check``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

DRIVE_LETTER_RE = re.compile(r"^[A-Za-z]:(/|$)")

SUPPORTED_CHECK_TYPES = (
    "stdout_exact",
    "stdout_contains",
    "exit_code",
    "file_exists",
    "file_contains",
    "file_empty",
)

# Required fields per check type, mirroring workers/verify.py::_check:
#   stdout_exact/stdout_contains/file_contains read "value";
#   exit_code reads int "value"; file_* read "path".
_CHECK_REQUIRED_FIELDS: dict[str, tuple[str, ...]] = {
    "stdout_exact": ("value",),
    "stdout_contains": ("value",),
    "exit_code": ("value",),
    "file_exists": ("path",),
    "file_contains": ("path", "value"),
    "file_empty": ("path",),
}


def is_safe_relative_path(relative: Any) -> bool:
    """True when ``relative`` is a safe relative path usable under a task root.

    Mirrors the intent of ``workers/verify.py::_safe_relative``: the resolved
    path must stay inside the root. Without a root to resolve against we
    reject anything that could escape one: absolute paths, any ".." component,
    empty/"." paths, and backslashes (Windows separators or literal).
    """
    if not isinstance(relative, str):
        return False
    candidate = relative.strip().replace("\\", "/")
    if not candidate or not candidate.strip("."):
        return False
    if candidate.startswith("/") or DRIVE_LETTER_RE.match(candidate):
        return False
    parts = [part for part in candidate.split("/") if part not in ("", ".")]
    if not parts:
        return False
    return ".." not in parts


@dataclass
class PiTask:
    """One benchmark-style shell task for a Pi rollout."""

    task_id: str = ""
    prompt: str = ""
    setup_files: dict[str, str] = field(default_factory=dict)
    environment: dict[str, str] = field(default_factory=dict)
    checks: list[dict] = field(default_factory=list)

    def validate(self) -> list[str]:
        """Return a list of human-readable problems; an empty list means valid."""
        problems: list[str] = []

        if not isinstance(self.task_id, str) or not self.task_id.strip():
            problems.append("task_id must be a non-empty string")
        if not isinstance(self.prompt, str) or not self.prompt.strip():
            problems.append("prompt must be a non-empty string")

        if not isinstance(self.setup_files, dict):
            problems.append("setup_files must be an object")
        else:
            for relative in self.setup_files:
                if not is_safe_relative_path(relative):
                    problems.append(f"setup_files key must be a safe relative path: {relative!r}")

        if not isinstance(self.checks, list):
            problems.append("checks must be a list")
        elif not self.checks:
            problems.append("checks must contain at least one check")
        else:
            for index, check in enumerate(self.checks):
                problems.extend(self._check_problems(index, check))

        return problems

    @staticmethod
    def _check_problems(index: int, check: Any) -> list[str]:
        if not isinstance(check, dict):
            return [f"checks[{index}] must be an object"]
        label = f"checks[{index}]"
        check_type = check.get("type")
        if check_type not in SUPPORTED_CHECK_TYPES:
            supported = ", ".join(SUPPORTED_CHECK_TYPES)
            return [f"{label} has unsupported check type: {check_type!r} (supported: {supported})"]
        problems: list[str] = []
        for name in _CHECK_REQUIRED_FIELDS[check_type]:
            if name not in check:
                problems.append(f"{label} ({check_type}) requires a {name} field")
        if check_type == "exit_code":
            value = check.get("value")
            if isinstance(value, bool) or not isinstance(value, int):
                problems.append(f"{label} (exit_code) value must be an integer")
        elif "value" in check and not isinstance(check.get("value"), str):
            problems.append(f"{label} ({check_type}) value must be a string")
        if "path" in check and not is_safe_relative_path(check.get("path")):
            problems.append(f"{label} ({check_type}) path must be a safe relative path: {check.get('path')!r}")
        return problems

    def require_valid(self) -> None:
        """Raise ValueError listing every problem when the task is invalid."""
        problems = self.validate()
        if problems:
            raise ValueError("invalid PiTask: " + "; ".join(problems))
