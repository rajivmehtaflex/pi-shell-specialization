import test from "node:test";
import assert from "node:assert/strict";
import { buildWeaknessProfile, compareProfiles, withCurriculumAnalysis } from "./insights.ts";
import type { ExternalAttemptRecord } from "./diagnostic-types.ts";

function row(model: string, caseId: string, passed: boolean): ExternalAttemptRecord {
  return {
    session_id: model,
    model,
    provider: "external",
    track: "raw",
    case_id: caseId,
    attempt: 1,
    response: "```bash\ntrue\n```",
    execution: {
      status: passed ? "passed" : "failed",
      syntax: "passed",
      verification: passed ? "passed" : "failed",
      exitCode: passed ? 0 : 1,
      stdout: "",
      stderr: "",
      durationMs: 1,
      findings: [],
      error: passed ? undefined : "fixture verification failed",
    },
    runner: { shell: "/bin/bash", shellVersion: "3.2", sandbox: "external-vm" },
  };
}

test("curriculum mix sums to 100 and prioritizes a weak category", () => {
  const profile = buildWeaknessProfile([
    row("student", "quote-001", false), row("student", "quote-002", false), row("student", "quote-003", false), row("student", "quote-004", false),
    row("student", "bash-001", true), row("student", "bash-002", true), row("student", "bash-003", true), row("student", "bash-004", true),
  ], { model: "student", track: "raw" });
  const enriched = withCurriculumAnalysis(profile);
  const total = Object.values(enriched.curriculumMix).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 100);
  const quote = Object.entries(enriched.curriculumMix).find(([category]) => category.includes("Quoting"))![1];
  const bash = Object.entries(enriched.curriculumMix).find(([category]) => category.includes("Bash syntax"))![1];
  assert.ok(quote > bash);
  assert.ok(enriched.recommendedStage2Priority.length > 0);
});

test("teacher comparison identifies high-value distillation targets", () => {
  const student = withCurriculumAnalysis(buildWeaknessProfile([
    row("student", "quote-001", false), row("student", "quote-002", false), row("student", "quote-003", false), row("student", "quote-004", false),
  ], { model: "student", track: "raw" }));
  const teacher = withCurriculumAnalysis(buildWeaknessProfile([
    row("teacher", "quote-001", true), row("teacher", "quote-002", true), row("teacher", "quote-003", true), row("teacher", "quote-004", true),
  ], { model: "teacher", track: "raw" }));
  const comparison = compareProfiles(student, teacher);
  assert.equal(comparison.length, 1);
  assert.equal(comparison[0].classification, "high-value-distillation-target");
  assert.ok(comparison[0].gap > 0);
});

test("protocol-only categories remain excluded from training priority", () => {
  const profile = buildWeaknessProfile([
    { ...row("student", "file-001", false), response: "I cannot provide a script.", execution: { ...row("student", "file-001", false).execution, syntax: "not-run", verification: "not-run" } },
    { ...row("student", "file-002", false), response: "I cannot provide a script.", execution: { ...row("student", "file-002", false).execution, syntax: "not-run", verification: "not-run" } },
    { ...row("student", "file-003", false), response: "I cannot provide a script.", execution: { ...row("student", "file-003", false).execution, syntax: "not-run", verification: "not-run" } },
    { ...row("student", "file-004", false), response: "I cannot provide a script.", execution: { ...row("student", "file-004", false).execution, syntax: "not-run", verification: "not-run" } },
  ], { model: "student", track: "raw" });
  const enriched = withCurriculumAnalysis(profile);
  assert.equal(enriched.recommendedStage2Priority.length, 0);
  assert.ok(enriched.doNotTrainYet.length > 0);
});
