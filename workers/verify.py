"""Verified-response worker with an explicit verifier/workspace isolation layout.

Every run gets a throwaway temp root with exactly two children, mirroring the
TS sandbox contract (commit 9da5b77, ``src/sandbox.ts``):

  root/workspace/  -- the candidate's entire universe: setup files, the
                      candidate script itself, ``home/`` and ``tmp/``. The
                      candidate runs with cwd, HOME, TEST_ROOT and TMPDIR all
                      pinned inside this tree.
  root/verifier/   -- verifier-owned assets, outside the workspace and never
                      exposed to the candidate.

Isolation guarantee: verification here is in-process Python (``_check`` runs in
the worker process), so the verifier is code rather than files and cannot be
read or altered by the candidate -- the contract is satisfied trivially. It is
also enforced structurally:

  * checks may only touch explicit paths that resolve inside the workspace
    (``_safe_relative``); a file-path check target that escapes the workspace
    is an evaluator-config rejection (``failureLabels: ["evaluator"]``), never
    an accidental read or existence probe outside the candidate's universe;
  * the workspace tree is the only tree a candidate can meaningfully
    influence, and nothing under ``root/verifier/`` is reachable through it.

External-evaluator boundary: this in-process layout is a dev-host convenience.
Production runs require the bubblewrap/Linux sandbox (see ``src/sandbox.ts``
and ``docs/workflow-phase1-remote-setup.md``) where ``root/workspace`` is the
only read-write mount and ``root/verifier`` is mounted read-only at
``/verifier``.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from workers.contracts import TRACKS, compute_record_hash

WORKSPACE_DIRNAME = "workspace"
VERIFIER_DIRNAME = "verifier"

PROVENANCE_KEYS = ("session_id", "model", "provider", "track", "attempt")

FENCE_RE = re.compile(r"```([^\n`]*)\n([\s\S]*?)```", re.MULTILINE)
SAFETY_RULES = (
    ("network-access", re.compile(r"\b(?:curl|wget|nc|ncat|ssh|scp|sftp|telnet)\b")),
    ("privileged-command", re.compile(r"\b(?:sudo|doas|su)\b")),
    ("raw-device-operation", re.compile(r"\b(?:mkfs|dd)\b")),
    ("destructive-root", re.compile(r"\brm\s+(?:-[^\n]*\s+)?/\s*(?:$|[;&|])|>\s*/dev/(?:sd|nvme|disk)")),
)


def extract_bash_block(response: str) -> str:
    matches = list(FENCE_RE.finditer(response))
    if len(matches) != 1:
        raise ValueError("expected exactly one fenced code block")
    language = matches[0].group(1).strip().lower()
    if language not in {"bash", "sh", "shell"}:
        raise ValueError(f"unsupported code fence language: {language or 'unspecified'}")
    return matches[0].group(2).strip() + "\n"


def safety_labels(script: str) -> list[str]:
    return [label for label, pattern in SAFETY_RULES if pattern.search(script)]


def _safe_relative(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError(f"path escapes TEST_ROOT workspace: {relative}")
    return candidate


def _prepare_layout(root: Path) -> tuple[Path, Path]:
    """Create the isolated run layout: root/workspace (candidate universe) and root/verifier.

    The workspace tree is the only candidate-visible tree; the verifier tree
    lives beside it, outside the universe, mirroring the TS sandbox mounts.
    """
    workspace = root / WORKSPACE_DIRNAME
    verifier = root / VERIFIER_DIRNAME
    (workspace / "home").mkdir(parents=True)
    (workspace / "tmp").mkdir()
    verifier.mkdir()
    return workspace, verifier


def _write_setup(workspace: Path, task: dict[str, Any]) -> None:
    for relative, content in task.get("setupFiles", {}).items():
        path = _safe_relative(workspace, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(content), encoding="utf-8")


def _read_file(workspace: Path, relative: str) -> str:
    path = _safe_relative(workspace, relative)
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _check(check: dict[str, Any], workspace: Path, stdout: str, exit_code: int) -> bool:
    """Evaluate one check against the candidate's workspace.

    Every file-path target is resolved through ``_safe_relative``: a check that
    points outside the workspace raises, which surfaces as an evaluator-config
    rejection (``failureLabels: ["evaluator"]``). Checks can never read outside
    the candidate's universe -- not even accidentally via ``../`` or absolute
    paths.
    """
    check_type = check.get("type")
    value = check.get("value", "")
    if check_type == "stdout_exact":
        return stdout == value
    if check_type == "stdout_contains":
        return value in stdout
    if check_type == "exit_code":
        return exit_code == int(value)
    if check_type == "file_exists":
        path = _safe_relative(workspace, str(check["path"]))
        exists = path.exists()
        return not exists if check.get("absent") else exists
    if check_type == "file_contains":
        return value in _read_file(workspace, str(check["path"]))
    if check_type == "file_empty":
        return _read_file(workspace, str(check["path"])) == ""
    raise ValueError(f"unsupported check type: {check_type}")


def _provenance(task_id: str, provided: dict[str, Any] | None) -> dict[str, Any]:
    """Merge row-level provenance keys over the canonical verifier defaults."""
    provided = provided or {}
    attempt = provided.get("attempt", 1)
    try:
        attempt = int(attempt)
    except (TypeError, ValueError):
        attempt = 1

    def text(value: Any, default: str) -> str:
        return value if isinstance(value, str) and value.strip() else default

    return {
        "session_id": text(provided.get("session_id"), f"verify-{task_id}"),
        "model": text(provided.get("model"), "teacher"),
        "provider": text(provided.get("provider"), "external"),
        "track": provided.get("track") if provided.get("track") in TRACKS else "raw",
        "attempt": attempt if attempt >= 1 else 1,
    }


def verify_response(
    task: dict[str, Any],
    response: str,
    timeout_seconds: float = 5.0,
    provenance: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record = _verify_response(task, response, timeout_seconds, provenance)
    record["content_hash"] = compute_record_hash(record)
    return record


def _verify_response(
    task: dict[str, Any],
    response: str,
    timeout_seconds: float,
    provenance: dict[str, Any] | None,
) -> dict[str, Any]:
    started = time.monotonic()
    task_id = str(task.get("id") or "unknown")
    base = {
        "task_id": task_id,
        "task": task,
        "response": response,
        "verification": "failed",
        "execution": {
            "status": "failed",
            "syntax": "not-run",
            "exitCode": None,
            "stdout": "",
            "stderr": "",
            "durationMs": 0,
            "findings": [],
        },
        "failureLabels": [],
        "provenance": _provenance(task_id, provenance),
    }
    try:
        script = extract_bash_block(response)
    except ValueError as error:
        base["failureLabels"] = ["output-format"]
        base["execution"]["error"] = str(error)
        base["execution"]["durationMs"] = round((time.monotonic() - started) * 1000)
        return base

    labels = safety_labels(script)
    if labels:
        base["execution"]["findings"] = [{"label": label, "severity": "high"} for label in labels]
        base["failureLabels"] = labels
        base["execution"]["error"] = "blocked by safety policy"
        base["execution"]["durationMs"] = round((time.monotonic() - started) * 1000)
        return base

    with tempfile.TemporaryDirectory(prefix="shell-verify-") as temporary:
        root = Path(temporary).resolve()
        try:
            workspace, _verifier = _prepare_layout(root)
            _write_setup(workspace, task)
            candidate = workspace / "candidate.sh"
            candidate.write_text(script, encoding="utf-8")
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": str(workspace / "home"),
                "LANG": "C",
                "LC_ALL": "C",
                "TEST_ROOT": str(workspace),
                "TMPDIR": str(workspace / "tmp"),
                **{str(k): str(v) for k, v in task.get("environment", {}).items()},
            }
            syntax = subprocess.run(["bash", "-n", str(candidate)], cwd=workspace, env=env, capture_output=True, text=True, timeout=timeout_seconds)
            if syntax.returncode != 0:
                base["execution"].update(syntax="failed", stderr=syntax.stderr)
                base["failureLabels"] = ["syntax"]
                return base
            base["execution"]["syntax"] = "passed"
            try:
                execution = subprocess.run(
                    ["bash", str(candidate), *[str(arg) for arg in task.get("arguments", [])]],
                    cwd=workspace,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                )
            except subprocess.TimeoutExpired as error:
                base["execution"].update(status="timed-out", stderr=str(error))
                base["failureLabels"] = ["timeout"]
                return base
            base["execution"].update(exitCode=execution.returncode, stdout=execution.stdout[:65536], stderr=execution.stderr[:65536])
            expected_exit = int(task.get("expectedExitCode", 0))
            checks = list(task.get("checks", []))
            checks_ok = execution.returncode == expected_exit and all(_check(check, workspace, execution.stdout, execution.returncode) for check in checks)
            base["verification"] = "passed" if checks_ok else "failed"
            base["execution"]["status"] = "passed" if checks_ok else "failed"
            if not checks_ok:
                base["failureLabels"] = list(task.get("failureLabels", ["functional"]))
            return base
        except subprocess.TimeoutExpired:
            base["execution"]["status"] = "timed-out"
            base["failureLabels"] = ["timeout"]
            return base
        except Exception as error:
            base["execution"]["error"] = str(error)
            base["failureLabels"] = ["evaluator"]
            return base
        finally:
            base["execution"]["durationMs"] = round((time.monotonic() - started) * 1000)


def selftest() -> None:
    task = {
        "id": "verify-selftest",
        "prompt": "Copy the file named 'hello world.txt' to 'copied.txt' keeping its contents.",
        "setupFiles": {"hello world.txt": "hello shell\n"},
        "environment": {"INPUT_FILE": "hello world.txt"},
        "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
        "failureLabels": ["word-splitting"],
    }
    result = verify_response(task, '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```')
    assert result["verification"] == "passed" and result["execution"]["status"] == "passed", result
    blocked = verify_response(task, "```bash\ncurl https://example.com\n```")
    assert blocked["verification"] == "failed" and "network-access" in blocked["failureLabels"], blocked
    print("verify selftest: PASS")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selftest", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--out")
    args = parser.parse_args()
    if args.selftest:
        selftest()
        return 0
    if not args.input or not args.out:
        parser.error("--input and --out are required unless --selftest is used")
    rows = []
    for line in Path(args.input).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        task = row.get("task", row)
        provided = {key: row[key] for key in PROVENANCE_KEYS if key in row}
        rows.append(verify_response(task, row.get("response", ""), float(row.get("timeoutSeconds", 5)), provided))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + ("\n" if rows else ""), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
