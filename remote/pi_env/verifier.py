"""Hidden verifier for Pi rollouts.

``run_verifier`` executes AFTER Pi exits: it applies every check from
``task.checks`` against the candidate workspace using EXACTLY the semantics of
``workers/verify.py::_check``:

  * ``stdout_exact`` / ``stdout_contains`` compare the captured Pi stdout,
  * ``exit_code`` compares the captured Pi exit code,
  * ``file_exists`` (honoring the ``absent`` flag), ``file_contains`` and
    ``file_empty`` inspect files under the candidate workspace only.

Verifier assets live in ``workspace.verifier`` (a sibling of the candidate
workspace), so file checks -- which resolve strictly inside the workspace --
can never observe them. Missing or malformed checks never reach this module:
``run_verifier`` asserts ``task.require_valid()`` first, mirroring the
``workers/verify.py`` vocabulary for the returned snapshot:

    {"verification": "passed"|"failed",
     "execution": {"status": "passed"|"failed"|"timed-out",
                   "exitCode": int|None, "stdout": str, "stderr": str},
     "failureLabels": [...]}

The ``runner`` argument carries the captured Pi process outcome: either an
execution snapshot mapping (``status``/``exitCode``/``stdout``/``stderr``) or a
zero-argument callable returning one.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Mapping

from .sandbox import RolloutWorkspace
from .task import PiTask

# Mirror workers/verify.py: captured streams are truncated to 64 KiB.
MAX_VERIFIER_CAPTURE = 65536

TIMED_OUT_STATUS = "timed-out"
ERROR_STATUS = "error"


def safe_workspace_path(workspace_dir: str | Path, relative: str) -> Path:
    """Resolve ``relative`` strictly inside ``workspace_dir`` (verify.py mirror).

    Raises ValueError when the resolved path escapes the workspace root.
    """
    root = Path(workspace_dir).resolve()
    candidate = (root / str(relative)).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"path escapes workspace: {relative}")
    return candidate


def read_workspace_file(workspace_dir: str | Path, relative: str) -> str:
    """Read a workspace file; a missing file reads as "" (verify.py mirror)."""
    path = safe_workspace_path(workspace_dir, relative)
    return path.read_text(encoding="utf-8") if path.exists() else ""


def check_passes(check: Mapping[str, Any], workspace_dir: str | Path, stdout: str, exit_code: Any) -> bool:
    """Exactly one check, with the semantics of workers/verify.py::_check."""
    check_type = check.get("type")
    value = check.get("value", "")
    if check_type == "stdout_exact":
        return stdout == value
    if check_type == "stdout_contains":
        return value in stdout
    if check_type == "exit_code":
        return exit_code == int(value)
    if check_type == "file_exists":
        exists = safe_workspace_path(workspace_dir, str(check["path"])).exists()
        return not exists if check.get("absent") else exists
    if check_type == "file_contains":
        return value in read_workspace_file(workspace_dir, str(check["path"]))
    if check_type == "file_empty":
        return read_workspace_file(workspace_dir, str(check["path"])) == ""
    raise ValueError(f"unsupported check type: {check_type}")


def _resolve_snapshot(runner: Any) -> dict:
    """Accept a snapshot mapping or a zero-arg callable returning one."""
    if callable(runner) and not isinstance(runner, Mapping):
        runner = runner()
    if not isinstance(runner, Mapping):
        raise ValueError("runner must be an execution snapshot mapping or a zero-arg callable returning one")
    return dict(runner)


def _snapshot_fields(snapshot: dict) -> tuple[str, Any, str, str]:
    status = str(snapshot.get("status") or "completed")
    exit_code = snapshot.get("exitCode", snapshot.get("exit_code"))
    stdout = str(snapshot.get("stdout") or "")
    stderr = str(snapshot.get("stderr") or "")
    return status, exit_code, stdout, stderr


def run_verifier(workspace: RolloutWorkspace, task: PiTask, runner: Any) -> dict:
    """Run every task check against the workspace after Pi exits (always runs).

    Even a failed, crashed or timed-out Pi run is verified: file checks are
    evaluated against whatever the rollout left behind, but a timed-out run
    can never pass (``failureLabels: ["timeout"]``), mirroring workers/verify.py.
    """
    task.require_valid()
    snapshot = _resolve_snapshot(runner)
    status, exit_code, stdout, stderr = _snapshot_fields(snapshot)
    workspace_dir = str(workspace.workspace)

    results: list[bool] = []
    for check in task.checks:
        try:
            results.append(bool(check_passes(check, workspace_dir, stdout, exit_code)))
        except Exception:  # noqa: BLE001 - one bad check fails that check only
            results.append(False)
    checks_ok = bool(results) and all(results)

    if status == TIMED_OUT_STATUS:
        verification, execution_status, labels = "failed", TIMED_OUT_STATUS, ["timeout"]
    elif status == ERROR_STATUS:
        verification, execution_status, labels = "failed", "failed", ["launch"]
    elif checks_ok:
        verification, execution_status, labels = "passed", "passed", []
    else:
        verification, execution_status, labels = "failed", "failed", ["functional"]

    return {
        "verification": verification,
        "execution": {
            "status": execution_status,
            "exitCode": exit_code,
            "stdout": stdout[:MAX_VERIFIER_CAPTURE],
            "stderr": stderr[:MAX_VERIFIER_CAPTURE],
        },
        "failureLabels": labels,
    }
