import test from "node:test";
import assert from "node:assert/strict";
import { generateShellTasks, renderQuestionGenerationPrompt } from "./question-generator.ts";
import type { WeaknessProfile } from "../insights.ts";

const profile: WeaknessProfile = {
  model: "qwen3.5:9b",
  track: "raw",
  categories: [],
  weaknesses: [{
    category: "Quoting, expansion, globbing, and arrays",
    label: "word-splitting",
    evidenceCount: 4,
    affectedCases: ["quote-001", "quote-004"],
    recommendation: "Add filenames with spaces.",
  }],
  curriculumMix: { "Quoting, expansion, globbing, and arrays": 70, "Bash syntax and script structure": 30 },
  recommendedStage2Priority: [],
  doNotTrainYet: [],
};

test("generation prompt includes weakness, dialect, schema, and leakage rules", () => {
  const prompt = renderQuestionGenerationPrompt(profile, 2);
  assert.match(prompt, /word-splitting/);
  assert.match(prompt, /Linux Bash 5/);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /Do not reveal|verifier/i);
});

test("generator parses and validates structured teacher-created tasks", async () => {
  const client = { async generate(_prompt: string) {
    return JSON.stringify({ tasks: [{
      id: "generated-001",
      category: "Quoting, expansion, globbing, and arrays",
      difficulty: "hard",
      dialect: "linux-bash5-gnu",
      prompt: "Copy a file whose name contains spaces.",
      setupFiles: { "hello world.txt": "x" },
      environment: { INPUT_FILE: "hello world.txt" },
      expectedInvariants: ["copied file exists"],
      checks: [{ type: "file_contains", path: "copied.txt", value: "x" }],
      failureLabels: ["word-splitting"],
      verifierSpec: "assert copied content equals x",
      sourceWeaknesses: ["word-splitting"],
      generatorModel: "fake-generator",
    }] });
  } };
  const tasks = await generateShellTasks(profile, client, 1);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].dialect, "linux-bash5-gnu");
  assert.equal(tasks[0].sourceWeaknesses[0], "word-splitting");
});

test("generator rejects duplicate IDs and dialect leakage", async () => {
  const client = { async generate(_prompt: string) {
    return JSON.stringify({ tasks: [{ id: "same", category: "x", difficulty: "easy", dialect: "macos", prompt: "x", setupFiles: {}, environment: {}, expectedInvariants: [], failureLabels: [], verifierSpec: "x", sourceWeaknesses: [], generatorModel: "x" }, { id: "same", category: "x", difficulty: "easy", dialect: "linux-bash5-gnu", prompt: "x", setupFiles: {}, environment: {}, expectedInvariants: [], failureLabels: [], verifierSpec: "x", sourceWeaknesses: [], generatorModel: "x" }] });
  } };
  await assert.rejects(() => generateShellTasks(profile, client, 2), /duplicate|dialect/i);
});
