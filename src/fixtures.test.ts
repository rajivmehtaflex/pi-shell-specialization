import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES } from "./cases.ts";
import { runScriptInSandbox } from "./sandbox.ts";
import type { DiagnosticCase } from "./types.ts";

// Reference-solution fixture validation: every case must be passable by a
// correct script. A reference solution that FAILS proves the fixture (not the
// model) is broken — impossible prompts lose their diagnostic value.

const SANDBOX = { backend: "host-temp" as const, allowUnsafeHostSandbox: true, timeoutMs: 5_000 };

function caseById(id: string): DiagnosticCase {
  const item = BENCHMARK_CASES.find((candidate) => candidate.id === id);
  assert.ok(item, `case ${id} not found`);
  return item!;
}

async function assertFixturePasses(id: string, referenceScript: string): Promise<void> {
  const item = caseById(id);
  const result = await runScriptInSandbox(referenceScript, item.testFixture, SANDBOX);
  assert.equal(
    result.status,
    "passed",
    `${id}: fixture rejected a correct reference solution — fixture bug.\n  error: ${result.error}\n  stderr: ${result.stderr.slice(0, 300)}`,
  );
}

test("fixtures pass reference solutions: environment variables reach the candidate", async (t) => {
  // These cases hand values to the script via $NAME / $COLOR / $INPUT_FILE / ...
  // For them to work, the fixture must set the variable in the candidate's
  // environment (fixture.environment), not just inside the setup script.
  await t.test("bash-003 uses $NAME", () =>
    assertFixturePasses("bash-003", 'greet() { printf "hello %s\\n" "$NAME" > "$TEST_ROOT/greeting.txt"; }; greet'));
  await t.test("bash-004 uses $COLOR", () =>
    assertFixturePasses("bash-004", 'case "$COLOR" in green) printf go > "$TEST_ROOT/result.txt";; esac'));
  await t.test("quote-001 uses $INPUT_FILE", () =>
    assertFixturePasses("quote-001", 'cp "$INPUT_FILE" "$TEST_ROOT/copied.txt"'));
  await t.test("quote-002 uses $PATTERN", () =>
    assertFixturePasses("quote-002", 'grep -F -- "$PATTERN" names.txt > "$TEST_ROOT/result.txt"'));
  await t.test("quote-005 uses $UNTRUSTED", () =>
    assertFixturePasses("quote-005", 'printf "%s\\n" "$UNTRUSTED" > "$TEST_ROOT/value.txt"'));
  await t.test("safe-001 uses $NAME", () =>
    assertFixturePasses("safe-001", 'printf "%s\\n" "$NAME" > "$TEST_ROOT/greeting.txt"'));
  await t.test("safe-005 uses $COMMAND", () =>
    assertFixturePasses("safe-005", 'case "$COMMAND" in date|printf|true) "$COMMAND" >/dev/null;; *) printf rejected > "$TEST_ROOT/result.txt";; esac'));
  await t.test("safe-006 uses $PORT", () =>
    assertFixturePasses("safe-006", 'case "$PORT" in ""|*[!0-9]*) printf invalid > "$TEST_ROOT/result.txt";; *) if [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; then printf valid > "$TEST_ROOT/result.txt"; else printf invalid > "$TEST_ROOT/result.txt"; fi;; esac'));
});

test("fixtures pass reference solutions: prompts that demand nonzero exits", async (t) => {
  await t.test("error-006 fails visibly with nonzero status", () =>
    assertFixturePasses(
      "error-006",
      'touch "$TEST_ROOT/temporary.txt"\ncleanup() { rm -f "$TEST_ROOT/temporary.txt"; }\ntrap cleanup EXIT\nfalse',
    ));
  await t.test("debug-002 detects pipeline failure", () =>
    assertFixturePasses("debug-002", 'set -o pipefail\nif ! grep needle missing.txt | wc -l > /dev/null; then exit 1; fi'));
  await t.test("debug-005 reports missing command on stderr", () =>
    assertFixturePasses("debug-005", 'if ! command -v definitely-missing-tool >/dev/null 2>&1; then printf "error: command not found\\n" >&2; exit 1; fi'));
});

test("fixtures pass reference solutions: prompts specify their output files", async (t) => {
  await t.test("file-005 writes the reversed lines to a stated output", () =>
    assertFixturePasses(
      "file-005",
      'tmp="$TEST_ROOT/work.tmp"\n tail -r "$TEST_ROOT/input.txt" > "$tmp" && mv "$tmp" "$TEST_ROOT/output.txt"',
    ));
  await t.test("pipe-003 writes every line to a stated output", () =>
    assertFixturePasses(
      "pipe-003",
      'while IFS= read -r line || [ -n "$line" ]; do printf "%s\\n" "$line" >> "$TEST_ROOT/output.txt"; done < "$TEST_ROOT/input.txt"',
    ));
  await t.test("debug-004 uppercases input into result.txt", () =>
    assertFixturePasses(
      "debug-004",
      'tmp="$TEST_ROOT/result.tmp"\nif tr a-z A-Z < "$TEST_ROOT/input.txt" > "$tmp"; then mv "$tmp" "$TEST_ROOT/result.txt"; else rm -f "$tmp"; exit 1; fi',
    ));
});

test("fixtures pass reference solutions: fully specified behavior", async (t) => {
  await t.test("agent-005 handles a missing jq without failing the contract", () =>
    assertFixturePasses(
      "agent-005",
      'if command -v jq >/dev/null 2>&1; then jq -r .name "$TEST_ROOT/input.json" > "$TEST_ROOT/result.txt"; else printf unavailable > "$TEST_ROOT/result.txt"; fi',
    ));
});
