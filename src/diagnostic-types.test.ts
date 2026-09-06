import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES } from "./cases.ts";
import {
  attemptKey,
  normalizeTeacherText,
  publicQuestion,
  teacherContentHash,
  validateAttemptRecord,
  validateTeacherRecord,
} from "./diagnostic-types.ts";

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

test("attempt validator rejects execution records with contradictory stage results", () => {
  assert.throws(
    () => validateAttemptRecord({ ...valid, execution: { ...valid.execution, status: "passed", syntax: "failed" } }, new Set(["bash-001"])),
    /inconsistent/i,
  );
  assert.throws(
    () => validateAttemptRecord({ ...valid, execution: { ...valid.execution, status: "passed", verification: "not-run" } }, new Set(["bash-001"])),
    /inconsistent/i,
  );
  assert.throws(
    () => validateAttemptRecord({ ...valid, execution: { ...valid.execution, status: "blocked", syntax: "passed" } }, new Set(["bash-001"])),
    /inconsistent/i,
  );
  assert.throws(
    () => validateAttemptRecord({ ...valid, execution: { ...valid.execution, status: "sandbox-unavailable", verification: "passed" } }, new Set(["bash-001"])),
    /inconsistent/i,
  );
});

test("attempt validator accepts worker-shaped records for every stage outcome", () => {
  // workers/verify.py blocked path: no syntax or verification stage ran
  assert.doesNotThrow(() =>
    validateAttemptRecord(
      { ...valid, execution: { ...valid.execution, status: "blocked", syntax: "not-run", verification: "not-run", exitCode: null } },
      new Set(["bash-001"]),
    ),
  );
  // sandbox-unavailable: nothing ran
  assert.doesNotThrow(() =>
    validateAttemptRecord(
      { ...valid, execution: { ...valid.execution, status: "sandbox-unavailable", syntax: "not-run", verification: "not-run", exitCode: null } },
      new Set(["bash-001"]),
    ),
  );
  // timed-out: syntax passed, verification never ran
  assert.doesNotThrow(() =>
    validateAttemptRecord(
      { ...valid, execution: { ...valid.execution, status: "timed-out", verification: "not-run", exitCode: null } },
      new Set(["bash-001"]),
    ),
  );
  // failed after the syntax check: verification never reached
  assert.doesNotThrow(() =>
    validateAttemptRecord(
      { ...valid, execution: { ...valid.execution, status: "failed", verification: "not-run", exitCode: 1 } },
      new Set(["bash-001"]),
    ),
  );
});

const TEACHER_TASK_PROMPT = "List files in /tmp";
const TEACHER_RESPONSE = "```bash\nls /tmp\n```\n";
const PINNED_HASH = "948a41ef29de3b185c57990fdc6bf3588d2d1308b9aba94f8cdc4fe137b926d3";

function teacherFixture(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "bash-001",
    task: { prompt: TEACHER_TASK_PROMPT, variant: "baseline" },
    response: TEACHER_RESPONSE,
    verification: "passed" as const,
    execution: { status: "passed" as const, exitCode: 0, durationMs: 12 },
    failureLabels: [] as string[],
    provenance: {
      session_id: "teacher-2026-09-06",
      model: "qwen3.5:9b",
      provider: "pi",
      track: "pi-tools" as const,
      attempt: 2,
    },
    content_hash: teacherContentHash(TEACHER_TASK_PROMPT, TEACHER_RESPONSE),
    ...overrides,
  };
}

test("teacher validator accepts a complete verified record", () => {
  assert.deepEqual(validateTeacherRecord(teacherFixture()), []);
});

test("teacher validator rejects malformed records", () => {
  const missingResponse = teacherFixture();
  delete (missingResponse as Record<string, unknown>).response;
  assert.match(validateTeacherRecord(missingResponse).join(" "), /response/i);
  assert.match(validateTeacherRecord(teacherFixture({ response: "   \n\t" })).join(" "), /response/i);
  assert.match(validateTeacherRecord(teacherFixture({ task: { prompt: "" } })).join(" "), /prompt/i);
  assert.match(validateTeacherRecord(teacherFixture({ provenance: { ...teacherFixture().provenance, track: "parrot" } })).join(" "), /track/i);
  assert.match(validateTeacherRecord(teacherFixture({ provenance: { ...teacherFixture().provenance, attempt: 0 } })).join(" "), /attempt/i);
  assert.match(validateTeacherRecord(teacherFixture({ response: "different answer" })).join(" "), /content_hash/i);
  assert.match(validateTeacherRecord(teacherFixture({ content_hash: "NOT-A-HASH" })).join(" "), /content_hash/i);
  assert.ok(validateTeacherRecord("not-a-record").length > 0);
});

test("teacher content hash matches pinned cross-language vector", () => {
  assert.equal(normalizeTeacherText("List files in /tmp\n"), "List files in /tmp");
  assert.equal(normalizeTeacherText("```bash\nls /tmp\n```\n"), "```bash ls /tmp ```");
  assert.equal(teacherContentHash("List files in /tmp\n", "```bash\nls /tmp\n```\n"), PINNED_HASH);
});

test("teacher content hash ignores trailing whitespace variants", () => {
  assert.equal(normalizeTeacherText("a\n\n"), normalizeTeacherText("a"));
  assert.equal(teacherContentHash("a\n\n", "b"), teacherContentHash("a", "b"));
  assert.equal(teacherContentHash("a", "b\t\t"), teacherContentHash("a", "b"));
});
