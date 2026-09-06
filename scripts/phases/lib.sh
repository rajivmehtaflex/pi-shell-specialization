#!/usr/bin/env bash
# lib.sh -- shared helpers for the phase scripts in scripts/phases/.
#
# Every phase script sources this file and follows one contract (mirrored by
# src/orchestrator/phase-ledger.ts `parsePhaseResultManifest`):
#
#   * strict mode: `set -euo pipefail`;
#   * the script calls `manifest_begin <phaseId>` exactly once, where
#     <phaseId> matches the phase id in src/orchestrator/phase-types.ts
#     (P0, P2.0, P2.1, P2.2, P2.3, P2.4, P2.5, P2.6, P2.6b, P2.7, P2.8);
#   * real artifacts are registered with `manifest_add_artifact <path>`;
#     digests are REAL sha256 sums (shasum -a 256, or sha256sum as fallback)
#     because the orchestrator recomputes them on resume -- a fake hash marks
#     the phase failed;
#   * artifact paths must live under state/, data/, artifacts/, or runs/
#     (git-sync COMMITTABLE_ROOTS) so checkpoints can commit them;
#   * the script ends with `manifest_emit_success` (requires at least one
#     artifact) or `phase_fail <message>`, which emits a failed manifest at
#     state/runs/<phaseId>/result.json and exits nonzero;
#   * external prerequisites (GPU training, the Pi binary, HF pushes, model
#     endpoints) fail fast with a clear "external prerequisite missing"
#     message before any work is attempted;
#   * phase scripts never push and never need the network for their
#     local-verifiable steps.
#
# Environment:
#   PHASE_PROJECT_ROOT  directory where state/, data/, artifacts/, runs/ are
#                       written. Defaults to the repository root that contains
#                       this lib.sh. Tests override it to point at a sandbox
#                       directory; the repository tree itself (workers/, src/,
#                       dist/) is always resolved from lib.sh's own location.

set -euo pipefail

PHASES_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${PHASES_LIB_DIR}/../.." && pwd)"
PROJECT_ROOT="${PHASE_PROJECT_ROOT:-${REPO_ROOT}}"

MANIFEST_PHASE=""
MANIFEST_ARTIFACTS=""
MANIFEST_HAS_ARTIFACTS=0
PACKAGE_CLI=()

# Current UTC timestamp in the ISO-8601 shape the ledger uses.
phase_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# REAL sha256 of a file. macOS ships shasum; many Linux images ship sha256sum.
sha256_of_file() {
  local path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    echo "manifest error: no sha256 tool found (need shasum or sha256sum)" >&2
    return 1
  fi
}

# Escape a string for embedding in one JSON line (errors are single-line).
json_escape() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="$(printf '%s' "$s" | tr '\n\r\t' '   ')"
  printf '%s' "$s"
}

# Start a result manifest for <phaseId>. Must be called before any other
# manifest helper.
manifest_begin() {
  local phase_id="$1"
  if [ -z "$phase_id" ]; then
    echo "manifest error: manifest_begin requires a phase id" >&2
    exit 1
  fi
  MANIFEST_PHASE="$phase_id"
  MANIFEST_ARTIFACTS=""
  MANIFEST_HAS_ARTIFACTS=0
}

# Register one real file as a phase artifact. The path may be absolute or
# relative to the current directory, PROJECT_ROOT, or the repository root;
# the manifest stores it relative to PROJECT_ROOT under one of the
# COMMITTABLE_ROOTS (state/, data/, artifacts/, runs/).
manifest_add_artifact() {
  local given="$1"
  if [ -z "$given" ]; then
    phase_fail "manifest_add_artifact requires a file path"
  fi
  local abs="$given"
  if [ ! -f "$abs" ]; then
    if [ -f "$PROJECT_ROOT/$given" ]; then
      abs="$PROJECT_ROOT/$given"
    elif [ -f "$REPO_ROOT/$given" ]; then
      abs="$REPO_ROOT/$given"
    fi
  fi
  if [ ! -f "$abs" ]; then
    phase_fail "manifest artifact is not a regular file: $given"
  fi
  local rel="$abs"
  case "$abs" in
    "$PROJECT_ROOT"/*) rel="${abs#"$PROJECT_ROOT"/}" ;;
  esac
  case "$rel" in
    state/*|data/*|artifacts/*|runs/*) ;;
    *)
      phase_fail "manifest artifact must live under state/, data/, artifacts/, or runs/ (COMMITTABLE_ROOTS): $rel"
      ;;
  esac
  local sha
  sha="$(sha256_of_file "$abs")" || phase_fail "cannot hash manifest artifact: $abs"
  if [ "${#sha}" -ne 64 ] || ! printf '%s' "$sha" | grep -qE '^[0-9a-f]{64}$'; then
    phase_fail "sha256 of $abs is not a plausible 64-hex digest: $sha"
  fi
  MANIFEST_ARTIFACTS="${MANIFEST_ARTIFACTS}${rel}"$'\t'"${sha}"$'\n'
  MANIFEST_HAS_ARTIFACTS=1
}

# Write the result manifest. Prints the manifest path.
manifest_write() {
  local status="$1" error="${2:-}"
  if [ -z "$MANIFEST_PHASE" ]; then
    echo "manifest error: manifest_begin was not called" >&2
    return 1
  fi
  local dir="$PROJECT_ROOT/state/runs/$MANIFEST_PHASE"
  mkdir -p "$dir"
  local tmp="$dir/.result.json.$$"
  {
    printf '{\n'
    printf '  "phase": "%s",\n' "$MANIFEST_PHASE"
    printf '  "status": "%s",\n' "$status"
    if [ "$MANIFEST_HAS_ARTIFACTS" -eq 1 ]; then
      printf '  "artifacts": [\n'
      local first=1 line rel sha
      while IFS=$'\t' read -r rel sha; do
        [ -n "$rel" ] || continue
        if [ "$first" -eq 1 ]; then
          first=0
        else
          printf ',\n'
        fi
        printf '    {"path": "%s", "sha256": "%s"}' "$rel" "$sha"
      done <<< "$MANIFEST_ARTIFACTS"
      printf '\n  ],\n'
    else
      printf '  "artifacts": [],\n'
    fi
    printf '  "completedAt": "%s"' "$(phase_now)"
    if [ -n "$error" ]; then
      printf ',\n  "error": "%s"\n' "$(json_escape "$error")"
    else
      printf '\n'
    fi
    printf '}\n'
  } > "$tmp"
  mv "$tmp" "$dir/result.json"
  printf '%s' "$dir/result.json"
}

# Emit a success manifest. The orchestrator refuses success manifests with an
# empty artifacts array, and so do we.
manifest_emit_success() {
  if [ -z "$MANIFEST_PHASE" ]; then
    echo "manifest error: manifest_begin was not called" >&2
    exit 1
  fi
  if [ "$MANIFEST_HAS_ARTIFACTS" -ne 1 ]; then
    echo "manifest error: phase $MANIFEST_PHASE cannot emit success without at least one artifact (call manifest_add_artifact)" >&2
    exit 1
  fi
  local path
  path="$(manifest_write success "")" || exit 1
  printf 'phase %s: success (%s)\n' "$MANIFEST_PHASE" "$path"
}

# Emit a failed manifest. Does not exit; prefer phase_fail, which also exits.
manifest_emit_failure() {
  local error="${1:-phase failed}"
  if [ -z "$MANIFEST_PHASE" ]; then
    echo "manifest error: manifest_begin was not called" >&2
    exit 1
  fi
  local path
  path="$(manifest_write failed "$error")" || exit 1
  printf 'phase %s: failed (%s)\n' "$MANIFEST_PHASE" "$path"
}

# Fail the phase: emit a failed manifest (when begun) and exit nonzero.
phase_fail() {
  local message="${1:-phase failed}"
  if [ -n "$MANIFEST_PHASE" ]; then
    manifest_emit_failure "$message" >/dev/null 2>&1 || true
  fi
  echo "phase ${MANIFEST_PHASE:-unknown} FAILED: $message" >&2
  exit 1
}

# Fail with a clear message when an environment variable is unset or empty.
require_env() {
  local var="$1" hint="${2:-}"
  case "$var" in
    [A-Za-z_][A-Za-z0-9_]*) ;;
    *) phase_fail "require_env requires a variable name, got: $var" ;;
  esac
  local value=""
  eval "value=\"\${${var}:-}\""
  if [ -z "$value" ]; then
    phase_fail "external prerequisite missing: environment variable $var is not set${hint:+; $hint}"
  fi
  printf '%s' "$value"
}

# Fail when a file is missing.
require_file() {
  local path="$1" description="${2:-file}"
  if [ -z "$path" ] || [ ! -f "$path" ]; then
    phase_fail "prerequisite missing: $description not found (expected at ${path:-<unset>})"
  fi
  printf '%s' "$path"
}

# Fail when a command is not on PATH.
require_command() {
  local cmd="$1" hint="${2:-}"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    phase_fail "external prerequisite missing: required command '$cmd' is not on PATH${hint:+; $hint}"
  fi
  printf '%s' "$cmd"
}

# HARD two-GPU gate for P2.6 (GRPO sharpening, loop-owning AsyncGRPO).
# Refuses every single-GPU configuration: GRPO_GPUS must list at least two
# distinct GPU ids (comma, semicolon, or whitespace separated), and
# PI_GRPO_REQUIRE_2_GPU must be "1" or unset. There is no override.
require_two_gpus() {
  if [ "${PI_GRPO_REQUIRE_2_GPU:-1}" != "1" ]; then
    phase_fail "PI_GRPO_REQUIRE_2_GPU must be '1' or unset: P2.6 AsyncGRPO is a hard two-GPU phase and never runs on a single GPU"
  fi
  local gpus="${GRPO_GPUS:-}"
  if [ -z "$gpus" ]; then
    phase_fail "external prerequisite missing: GRPO_GPUS must list at least two distinct GPU ids (e.g. GRPO_GPUS=0,1) for P2.6 AsyncGRPO; single-GPU configurations are refused by design"
  fi
  local distinct
  distinct="$(printf '%s\n' "$gpus" | tr ',; ' '\n\n\n' | sed '/^[[:space:]]*$/d' | sort -u | wc -l | tr -d ' ')"
  if [ "$distinct" -lt 2 ]; then
    phase_fail "external prerequisite missing: GRPO_GPUS lists $distinct distinct GPU id(s) ('$gpus'); P2.6 AsyncGRPO requires 2 GPUs (one for the policy vLLM server, one for the trainer) and never runs single-GPU"
  fi
  printf '%s' "$gpus"
}

# Run a python data worker (e.g. "split.py") from the repository's workers/
# directory with the repository root on PYTHONPATH (workers import
# "workers.contracts", which requires the repo root on sys.path). Remaining
# args are passed through. Nonzero exit propagates.
run_worker() {
  local worker="$1"
  shift
  PYTHONPATH="${REPO_ROOT}${PYTHONPATH:+:${PYTHONPATH}}" python3 "$REPO_ROOT/workers/$worker" "$@"
}

# Fill PACKAGE_CLI with the words that run the package CLI: prefer the built
# dist output (npm run build), fall back to Node type stripping (Node >= 22).
resolve_package_cli() {
  if [ -f "$REPO_ROOT/dist/src/cli.js" ]; then
    PACKAGE_CLI=(node "$REPO_ROOT/dist/src/cli.js")
  else
    PACKAGE_CLI=(node --experimental-strip-types "$REPO_ROOT/src/cli.ts")
  fi
}

# Run the package CLI with stdout+stderr captured into $1. Remaining args are
# the CLI arguments. Nonzero exit propagates (callers combine with ||).
run_package_cli() {
  local log="$1"
  shift
  mkdir -p "$(dirname "$log")"
  ( cd "$REPO_ROOT" && "${PACKAGE_CLI[@]}" "$@" ) > "$log" 2>&1
}

# Write the benchmark task pool (one {"task": ...} object per line, sourced
# from the 60 validated benchmark cases) to $1. Shared by P2.0 and P2.1.
build_tasks_jsonl() {
  local out="$1"
  require_command node "node >= 22 must be installed"
  require_command python3 "python3 must be installed"
  resolve_package_cli
  mkdir -p "$(dirname "$out")"
  ( cd "$REPO_ROOT" && "${PACKAGE_CLI[@]}" list ) \
    | python3 -c 'import json, sys
rows = json.load(sys.stdin)
for row in rows:
    print(json.dumps({"task": row}, sort_keys=True))' \
    > "$out"
  local rows
  rows="$(wc -l < "$out" | tr -d ' ')"
  if [ "$rows" -lt 1 ]; then
    phase_fail "benchmark task pool is empty: $out"
  fi
  printf '%s' "$rows"
}
