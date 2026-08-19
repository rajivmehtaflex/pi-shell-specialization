import test from "node:test";
import assert from "node:assert/strict";
import { renderWeaknessProfile } from "./report.ts";
import type { WeaknessProfile } from "./insights.ts";

const profile: WeaknessProfile = {
  model: "qwen3.5:9b",
  track: "raw",
  categories: [{
    category: "Quoting, expansion, globbing, and arrays",
    cases: 4,
    attempts: 4,
    passRate: 0.25,
    passAt1: 0.25,
    passAtN: 0.5,
    averageScore: 55,
    confidenceInterval: [0.05, 0.7],
    byDifficulty: { hard: { cases: 2, attempts: 2, passRate: 0, averageScore: 20 } },
    failureLabels: { "word-splitting": 3 },
    capabilityFailures: 3,
    protocolFailures: 0,
    evaluatorFailures: 0,
    confidence: "supported",
    verdict: "weak",
  }],
  weaknesses: [{
    category: "Quoting, expansion, globbing, and arrays",
    label: "word-splitting",
    evidenceCount: 3,
    affectedCases: ["quote-001", "quote-004"],
    recommendation: "Add filenames with spaces.",
  }],
  curriculumMix: { "Quoting, expansion, globbing, and arrays": 100 },
  recommendedStage2Priority: [],
  doNotTrainYet: [],
};

test("weakness report renders evidence, uncertainty, and training recommendations", () => {
  const markdown = renderWeaknessProfile(profile);
  assert.match(markdown, /Weakness Profile/);
  assert.match(markdown, /Pass@1/);
  assert.match(markdown, /word-splitting/);
  assert.match(markdown, /Add filenames with spaces/);
  assert.match(markdown, /100%/);
});
