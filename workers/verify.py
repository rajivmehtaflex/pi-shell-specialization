from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

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
        raise ValueError(f"path escapes TEST_ROOT: {relative}")
    return candidate


def _write_setup(root: Path, task: dict[str, Any]) -> None:
    for relative, content in task.get("setupFiles", {}).items():
        path = _safe_relative(root, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(content), encoding="utf-8")


def _read_file(root: Path, relative: str) -> str:
    path = _safe_relative(root, relative)
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _check(check: dict[str, Any], root: Path, stdout: str, exit_code: int) -> bool:
    check_type = check.get("type")
    value = check.get("value", "")
    if check_type == "stdout_exact":
        return stdout == value
    if check_type == "stdout_contains":
        return value in stdout
    if check_type == "exit_code":
        return exit_code == int(value)
    if check_type == "file_exists":
        exists = _safe_relative(root, str(check["path"])).exists()
        return not exists if check.get("absent") else exists
    if check_type == "file_contains":
        return value in _read_file(root, str(check["path"]))
    if check_type == "file_empty":
        return _read_file(root, str(check["path"])) == ""
    raise ValueError(f"unsupported check type: {check_type}")


def verify_response(task: dict[str, Any], response: str, timeout_seconds: float = 5.0) -> dict[str, Any]:
    started = time.monotonic()
    base = {
        "case_id": task.get("id", "unknown"),
        "response": response,
        "status": "failed",
        "syntax": "not-run",
        "verification": "not-run",
        "exitCode": None,
        "stdout": "",
        "stderr": "",
        "durationMs": 0,
        "findings": [],
        "failureLabels": [],
    }
    try:
        script = extract_bash_block(response)
    except ValueError as error:
        base["failureLabels"] = ["output-format"]
        base["error"] = str(error)
        base["durationMs"] = round((time.monotonic() - started) * 1000)
        return base

    labels = safety_labels(script)
    if labels:
        base["findings"] = [{"label": label, "severity": "high"} for label in labels]
        base["failureLabels"] = labels
        base["error"] = "blocked by safety policy"
        base["durationMs"] = round((time.monotonic() - started) * 1000)
        return base

    with tempfile.TemporaryDirectory(prefix="shell-verify-") as temporary:
        root = Path(temporary).resolve()
        try:
            _write_setup(root, task)
            candidate = root / "candidate.sh"
            candidate.write_text(script, encoding="utf-8")
            env = {
                "PATH": "/usr/local/bin:/usr/bin:/bin",
                "HOME": str(root / "home"),
                "LANG": "C",
                "LC_ALL": "C",
                "TEST_ROOT": str(root),
                "TMPDIR": str(root / "tmp"),
                **{str(k): str(v) for k, v in task.get("environment", {}).items()},
            }
            (root / "home").mkdir()
            (root / "tmp").mkdir()
            syntax = subprocess.run(["bash", "-n", str(candidate)], cwd=root, env=env, capture_output=True, text=True, timeout=timeout_seconds)
            if syntax.returncode != 0:
                base.update(syntax="failed", stderr=syntax.stderr, failureLabels=["syntax"])
                return base
            base["syntax"] = "passed"
            try:
                execution = subprocess.run(
                    ["bash", str(candidate), *[str(arg) for arg in task.get("arguments", [])]],
                    cwd=root,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                )
            except subprocess.TimeoutExpired as error:
                base.update(status="timed-out", stderr=str(error), failureLabels=["timeout"])
                return base
            base.update(exitCode=execution.returncode, stdout=execution.stdout[:65536], stderr=execution.stderr[:65536])
            expected_exit = int(task.get("expectedExitCode", 0))
            checks = list(task.get("checks", []))
            checks_ok = execution.returncode == expected_exit and all(_check(check, root, execution.stdout, execution.returncode) for check in checks)
            base["verification"] = "passed" if checks_ok else "failed"
            base["status"] = "passed" if checks_ok else "failed"
            if not checks_ok:
                base["failureLabels"] = list(task.get("failureLabels", ["functional"]))
            return base
        except subprocess.TimeoutExpired:
            base.update(status="timed-out", failureLabels=["timeout"])
            return base
        except Exception as error:
            base["error"] = str(error)
            base["failureLabels"] = ["evaluator"]
            return base
        finally:
            base["durationMs"] = round((time.monotonic() - started) * 1000)


def selftest() -> None:
    task = {
        "id": "verify-selftest",
        "setupFiles": {"hello world.txt": "hello shell\n"},
        "environment": {"INPUT_FILE": "hello world.txt"},
        "checks": [{"type": "file_contains", "path": "copied.txt", "value": "hello shell"}],
        "failureLabels": ["word-splitting"],
    }
    result = verify_response(task, '```bash\ncp "$INPUT_FILE" "$TEST_ROOT/copied.txt"\n```')
    assert result["status"] == "passed", result
    blocked = verify_response(task, "```bash\ncurl https://example.com\n```")
    assert blocked["status"] == "failed" and "network-access" in blocked["failureLabels"], blocked
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
        rows.append(verify_response(task, row.get("response", ""), float(row.get("timeoutSeconds", 5))))
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + ("\n" if rows else ""), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
