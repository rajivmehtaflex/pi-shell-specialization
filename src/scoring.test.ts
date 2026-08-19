import test from "node:test";
import assert from "node:assert/strict";
import { aggregateBenchmarkResults, scoreCase } from "./scoring.ts";
import type { DiagnosticCase, ExecutionResult } from "./types.ts";

const item: DiagnosticCase = {
  id: "test-001",
  category: "Bash syntax and script structure",
  difficulty: "easy",
  prompt: "Return a script.",
  requiredOutputFormat: "single-bash-fence",
  testFixture: { setup: "true", verify: "true" },
  expectedInvariants: ["script executes"],
  timeoutMs: 1000,
  scoreDimensions: {
    functionalCorrectness: 45,
    runtimeReliability: 20,
    safety: 20,
    portabilityReadability: 10,
    outputFormat: 5,
  },
  failureLabels: ["syntax"],
  tracks: ["raw", "pi-tools"],
};

const execution: ExecutionResult = {
  status: "passed",
  syntax: "passed",
  verification: "passed",
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 4,
  findings: [],
};

test("scores a passing fenced response at 100", () => {
  const result = scoreCase(item, "```bash\necho ok\n```", execution);
  assert.equal(result.total, 100);
  assert.deepEqual(result.failureLabels, []);
});

test("aggregates independent raw and Pi tool track profiles", () => {
  const results = [
    { ...scoreCase(item, "```bash\necho ok\n```", execution), track: "raw" as const, caseId: item.id, category: item.category },
    { ...scoreCase(item, "```bash\necho ok\n```", { ...execution, status: "failed", verification: "failed" }), track: "pi-tools" as const, caseId: item.id, category: item.category },
  ];
  const report = aggregateBenchmarkResults(results);
  assert.equal(report.tracks.raw.overallScore, 100);
  assert.equal(report.tracks["pi-tools"].overallScore, 55);
  assert.equal(report.tracks.raw.categories[item.category], 100);
});
