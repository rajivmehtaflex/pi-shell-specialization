"""Per-rollout workspace manager for Pi rollouts.

Mirrors the TS sandbox split (``src/sandbox.ts``): one rollout gets one root
directory containing a candidate-writable ``workspace/`` (setup files land
here, Pi's cwd) and a sibling ``verifier/`` directory that lives OUTSIDE the
workspace so a candidate stage cannot overwrite or displace the hidden
verifier assets before they run. Like the host-temp backend in ``sandbox.ts``,
this split offers no mount guarantees and must never be treated as secure.

Layout::

    <sandbox_root>/<task_id>-<timestamp>-<uuid>/
      workspace/          # candidate-writable; setup files, home/, tmp/
      verifier/           # hidden verifier assets (later waves)
      trace.jsonl         # interception trace for this rollout
"""

from __future__ import annotations

import re
import shutil
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from .task import is_safe_relative_path

WORKSPACE_DIRNAME = "workspace"
VERIFIER_DIRNAME = "verifier"
TRACE_FILENAME = "trace.jsonl"


@dataclass
class RolloutWorkspace:
    """Paths for one rollout: candidate workspace, verifier dir, trace file."""

    root: str
    workspace: str
    verifier: str
    trace_path: str
    sandbox_root: str = ""
    task_id: str = ""


def sanitize_task_id(task_id: Any) -> str:
    """Reduce a task id to one safe path component (no separators, no "..")."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(task_id)).strip("._-")
    return cleaned or "task"


def create_rollout_workspace(sandbox_root: str | Path, task_id: str) -> RolloutWorkspace:
    """Create a fresh rollout root under ``sandbox_root`` and return its paths."""
    if not isinstance(sandbox_root, (str, Path)) or not str(sandbox_root).strip():
        raise ValueError("sandbox_root must be a non-empty string")
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError("task_id must be a non-empty string")
    safe_id = sanitize_task_id(task_id)
    resolved_root = Path(sandbox_root).resolve()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    rollout_root = resolved_root / f"{safe_id}-{stamp}-{uuid.uuid4().hex[:8]}"
    workspace = rollout_root / WORKSPACE_DIRNAME
    verifier = rollout_root / VERIFIER_DIRNAME
    workspace.mkdir(parents=True)
    (workspace / "home").mkdir()
    (workspace / "tmp").mkdir()
    verifier.mkdir()
    (rollout_root / TRACE_FILENAME).touch()
    return RolloutWorkspace(
        root=str(rollout_root),
        workspace=str(workspace),
        verifier=str(verifier),
        trace_path=str(rollout_root / TRACE_FILENAME),
        sandbox_root=str(resolved_root),
        task_id=safe_id,
    )


def write_setup_files(ws: RolloutWorkspace, setup_files: Mapping[str, Any]) -> None:
    """Write task setup files into the candidate workspace.

    Every key must pass the same relative-path safety check as ``PiTask``,
    mirroring ``workers/verify.py::_safe_relative``; otherwise nothing is
    written and ValueError is raised.
    """
    if not isinstance(setup_files, Mapping):
        raise ValueError("setup_files must be a mapping of relative path to content")
    workspace = Path(ws.workspace)
    for relative, content in setup_files.items():
        if not is_safe_relative_path(relative):
            raise ValueError(f"setup file path escapes workspace: {relative!r}")
        target = workspace / str(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(str(content), encoding="utf-8")


def cleanup_workspace(ws: RolloutWorkspace) -> None:
    """Remove the rollout tree, refusing suspicious roots.

    Refuses (with ValueError) empty roots, the filesystem root, roots outside
    the recorded sandbox_root, and roots whose name lacks the expected
    ``<task_id>-`` prefix from ``create_rollout_workspace``.
    """
    root = str(getattr(ws, "root", "") or "").strip()
    if not root:
        raise ValueError("refusing to clean up workspace with empty root")
    resolved = Path(root).resolve()
    if resolved == Path(resolved.anchor):
        raise ValueError(f"refusing to clean up filesystem root: {root!r}")
    sandbox_root = str(getattr(ws, "sandbox_root", "") or "").strip()
    task_id = str(getattr(ws, "task_id", "") or "").strip()
    if not sandbox_root or not task_id:
        raise ValueError(f"refusing to clean up workspace without provenance: {root!r}")
    resolved_sandbox = Path(sandbox_root).resolve()
    if resolved == resolved_sandbox or resolved_sandbox not in resolved.parents:
        raise ValueError(f"refusing to clean up root outside sandbox_root: {root!r}")
    if not resolved.name.startswith(f"{task_id}-"):
        raise ValueError(f"refusing to clean up root without expected prefix: {root!r}")
    shutil.rmtree(resolved, ignore_errors=True)
