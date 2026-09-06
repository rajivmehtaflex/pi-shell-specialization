import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES } from "./cases.ts";
import { buildWeaknessProfile, wilsonInterval } from "./insights.ts";
import type { ExternalAttemptRecord } from "./diagnostic-types.ts";

function record(caseId: string, passed: boolean, response = "```bash\ntrue\n```", attempt = 1): ExternalAttemptRecord {
  return {
    session_id: "s1",
    model: "qwen3.5:9b",
    provider: "external",
    track: "raw",
    case_id: caseId,
    attempt,
    response,
    execution: {
      status: passed ? "passed" : "failed",
      syntax: passed ? "passed" : response.includes("```") ? "passed" : "not-run",
      verification: passed ? "passed" : response.includes("```") ? "failed" : "not-run",
      exitCode: passed ? 0 : 1,
      stdout: "",
      stderr: "",
      durationMs: 10,
      findings: [],
      error: passed ? undefined : "fixture verification failed",
    },
    runner: { shell: "/bin/bash", shellVersion: "3.2", sandbox: "external-vm", temperature: 0, seed: 42 },
  };
}

test("Wilson interval is bounded and contains the observed proportion", () => {
  const [low, high] = wilsonInterval(2, 4);
  assert.ok(low >= 0 && high <= 1 && low <= 0.5 && high >= 0.5);
});

test("repeated functional failures produce a supported category weakness", () => {
  const records = [
    record("quote-001", false),
    record("quote-002", false),
    record("quote-003", false),
    record("quote-004", false),
    record("bash-001", true),
    record("bash-002", true),
    record("bash-003", true),
    record("bash-004", true),
  ];
  const profile = buildWeaknessProfile(records, { model: "qwen3.5:9b", track: "raw" });
  const quote = profile.categories.find((item) => item.category === BENCHMARK_CASES.find((c) => c.id === "quote-001")!.category)!;
  assert.equal(quote.passRate, 0);
  assert.equal(quote.confidence, "supported");
  assert.equal(quote.verdict, "weak");
  assert.ok(Object.values(quote.failureLabels).some((count) => count >= 2));
  assert.ok(profile.weaknesses.some((item) => item.affectedCases.length >= 2));
});

test("protocol-only failures do not become capability weaknesses", () => {
  const records = [
    record("file-001", false, "I cannot provide a script."),
    record("file-002", false, "I cannot provide a script."),
    record("file-003", false, "I cannot provide a script."),
    record("file-004", false, "I cannot provide a script."),
  ];
  const profile = buildWeaknessProfile(records, { model: "qwen3.5:9b", track: "raw" });
  const insight = profile.categories[0];
  assert.equal(insight.capabilityFailures, 0);
  assert.equal(insight.protocolFailures, 4);
  assert.equal(insight.confidence, "insufficient");
  assert.equal(profile.weaknesses.length, 0);
});

test("fewer than four capability cases remain insufficient", () => {
  const profile = buildWeaknessProfile([record("safe-001", false), record("safe-002", true)], { model: "m", track: "raw" });
  assert.equal(profile.categories[0].confidence, "insufficient");
});

test("pass rate uses first attempts while pass@N recognizes a later success", () => {
  const profile = buildWeaknessProfile([
    record("bash-001", false, "```bash\nfalse\n```", 1),
    record("bash-001", true, "```bash\ntrue\n```", 2),
    record("bash-002", true, "```bash\ntrue\n```", 1),
  ], { model: "m", track: "raw" });
  assert.equal(profile.categories[0].passRate, 0.5);
  assert.equal(profile.categories[0].passAtN, 1);
});

test("mixed-model cohorts are rejected", () => {
  const mixed = [record("bash-001", true), { ...record("bash-002", true), model: "other-model" }];
  assert.throws(() => buildWeaknessProfile(mixed), /mixed cohort.*other-model/s);
});

test("mixed-track cohorts are rejected", () => {
  const mixed = [record("bash-001", true), { ...record("bash-002", true), track: "pi-tools" as const }];
  assert.throws(() => buildWeaknessProfile(mixed), /mixed cohort/);
});

test("mixed-provider cohorts are rejected", () => {
  const mixed = [record("bash-001", true), { ...record("bash-002", true), provider: "other-provider" }];
  assert.throws(() => buildWeaknessProfile(mixed), /mixed cohort/);
});

test("homogeneous cohorts pass with derived or explicit labels", () => {
  const homogeneous = [record("bash-001", true), record("bash-002", true)];
  const derived = buildWeaknessProfile(homogeneous);
  assert.equal(derived.model, "qwen3.5:9b");
  assert.equal(derived.track, "raw");
  const explicit = buildWeaknessProfile(homogeneous, { model: "qwen3.5:9b", track: "raw" });
  assert.equal(explicit.model, "qwen3.5:9b");
  assert.equal(explicit.track, "raw");
});
