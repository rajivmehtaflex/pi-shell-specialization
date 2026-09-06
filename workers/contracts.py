"""Canonical verified-data envelope shared by all Python workers and the TS side.

A verified record is a dict with the fields documented in ``ENVELOPE_FIELDS``.
``content_hash`` is a cross-language pinned sha256 over a canonical JSON payload
built from the normalized task prompt and response, so TypeScript and Python
compute byte-identical hashes.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

WHITESPACE_RE = re.compile(r"\s+")
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
VERIFICATIONS = ("passed", "failed")
TRACKS = ("raw", "pi-tools")


def normalize_text(text: str) -> str:
    """Collapse every whitespace run (spaces, tabs, newlines) to a single space, then strip."""
    return WHITESPACE_RE.sub(" ", text).strip()


def content_hash(task_text: str, response: str) -> str:
    """sha256 (UTF-8) of the canonical payload {"response": ..., "task": ...}.

    Serialized with sorted keys ("response" before "task"), Python-default
    separators (", " and ": ") and ensure_ascii=False.
    """
    payload = {"response": normalize_text(response), "task": normalize_text(task_text)}
    serialized = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def compute_record_hash(record: dict[str, Any]) -> str:
    """content_hash derived from the record's task prompt and response."""
    task = record.get("task")
    prompt = task.get("prompt", "") if isinstance(task, dict) else ""
    return content_hash(str(prompt), str(record.get("response", "")))


def validate_envelope(record: dict[str, Any]) -> list[str]:
    """Return a list of human-readable problems; an empty list means valid."""
    if not isinstance(record, dict):
        return ["record must be an object"]

    problems: list[str] = []

    task_id = record.get("task_id")
    if not isinstance(task_id, str) or not task_id.strip():
        problems.append("task_id must be a non-empty string")

    task = record.get("task")
    prompt = None
    if not isinstance(task, dict):
        problems.append("task must be an object")
    else:
        prompt = task.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            problems.append("task.prompt must be a non-empty string")

    response = record.get("response")
    if not isinstance(response, str) or not response.strip():
        problems.append("response must be a non-empty string")

    if record.get("verification") not in VERIFICATIONS:
        problems.append('verification must be "passed" or "failed"')

    if not isinstance(record.get("execution"), dict):
        problems.append("execution must be an object")

    failure_labels = record.get("failureLabels")
    if not isinstance(failure_labels, list) or not all(isinstance(label, str) for label in failure_labels):
        problems.append("failureLabels must be a list of strings")

    provenance = record.get("provenance")
    if not isinstance(provenance, dict):
        problems.append("provenance must be an object")
    else:
        for key in ("session_id", "model", "provider"):
            value = provenance.get(key)
            if not isinstance(value, str) or not value.strip():
                problems.append(f"provenance.{key} must be a non-empty string")
        if provenance.get("track") not in TRACKS:
            problems.append('provenance.track must be "raw" or "pi-tools"')
        attempt = provenance.get("attempt")
        if isinstance(attempt, bool) or not isinstance(attempt, int) or attempt < 1:
            problems.append("provenance.attempt must be an integer >= 1")

    recorded_hash = record.get("content_hash")
    if not isinstance(recorded_hash, str) or not HASH_RE.fullmatch(recorded_hash):
        problems.append("content_hash must be a 64-character lowercase hex string")
    elif isinstance(task, dict) and isinstance(prompt, str) and isinstance(response, str):
        expected = compute_record_hash(record)
        if recorded_hash != expected:
            problems.append(f"content_hash mismatch: expected {expected}, got {recorded_hash}")

    return problems


def assert_valid_envelope(record: dict[str, Any]) -> None:
    """Raise ValueError listing every problem when the record is not a valid envelope."""
    problems = validate_envelope(record)
    if problems:
        raise ValueError("invalid verified-data envelope: " + "; ".join(problems))
