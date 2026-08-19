import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES } from "./cases.ts";
import { attemptKey, publicQuestion, validateAttemptRecord } from "./diagnostic-types.ts";

const valid = {
  session_id: "s1",
  model: "qwen3.5:9b",
  provider: "external",
  track: "raw" as const,
  case_id: "bash-001",
  attempt: 1,
  response: "```bash\necho ok\n```",
  execution: {
    status: "passed" as const,
    syntax: "passed" as const,
    verification: "passed" as const,
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 10,
    findings: [],
  },
  runner: {
    shell: "/bin/bash",
    shellVersion: "3.2",
    sandbox: "external-vm",
    temperature: 0,
    seed: 42,
  },
};

test("public question excludes fixture and verifier data", () => {
  const question = publicQuestion(BENCHMARK_CASES[0]);
  assert.equal(question.id, BENCHMARK_CASES[0].id);
  assert.equal("testFixture" in question, false);
  assert.equal("verify" in question, false);
  assert.match(question.prompt, /Bash|script|Write/i);
});

test("attempt validator accepts a complete external result", () => {
  assert.doesNotThrow(() => validateAttemptRecord(valid, new Set(["bash-001"])));
});

test("attempt validator rejects unknown cases and incomplete records", () => {
  assert.throws(() => validateAttemptRecord({ ...valid, case_id: "unknown" }, new Set(["bash-001"])), /case_id/i);
  assert.throws(() => validateAttemptRecord({ ...valid, response: "" }, new Set(["bash-001"])), /incomplete|response/i);
});

test("attempt validator rejects duplicate session-track-case-attempt keys", () => {
  const seen = new Set([attemptKey(valid)]);
  assert.throws(() => validateAttemptRecord(valid, new Set(["bash-001"]), seen), /duplicate/i);
});
