import test from "node:test";
import assert from "node:assert/strict";
import { generateShellTasks, renderQuestionGenerationPrompt, validateGeneratedTask } from "./question-generator.ts";
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

function validGeneratedTask(): Record<string, unknown> {
  return {
    id: "valid-001",
    category: "Quoting, expansion, globbing, and arrays",
    difficulty: "medium",
    dialect: "linux-bash5-gnu",
    prompt: "Copy the input file to the output file without corrupting its name.",
    setupFiles: { "input file.txt": "payload\n" },
    environment: { INPUT_FILE: "input file.txt" },
    expectedInvariants: ["copied file keeps its content"],
    checks: [{ type: "file_contains", path: "copied.txt", value: "payload" }],
    failureLabels: ["word-splitting"],
    verifierSpec: "assert copied.txt contains payload",
    sourceWeaknesses: ["word-splitting"],
    generatorModel: "fake-generator",
  };
}

test("validateGeneratedTask accepts a fully valid task", () => {
  const task = validateGeneratedTask(validGeneratedTask());
  assert.equal(task.id, "valid-001");
  assert.equal(task.checks.length, 1);
});

test("validateGeneratedTask rejects missing or empty setupFiles", () => {
  for (const setupFiles of [undefined, {}, { "notes.txt": 7 }]) {
    assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), setupFiles }), /setupFiles/i);
  }
  assert.doesNotThrow(() => validateGeneratedTask({ ...validGeneratedTask(), setupFiles: { "empty.txt": "" } }));
});

test("validateGeneratedTask rejects non-string environment values and non-object environment", () => {
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), environment: { THREADS: 4 } }), /environment/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), environment: "INPUT_FILE=x" }), /environment/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), environment: null }), /environment/i);
});

test("validateGeneratedTask rejects missing or empty checks", () => {
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [] }), /checks/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: undefined }), /checks/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: "file_contains" }), /checks/i);
});

test("validateGeneratedTask rejects unsupported check types", () => {
  const task = validGeneratedTask();
  (task.checks as unknown[]).push({ type: "stdout_regex", value: "x" });
  assert.throws(() => validateGeneratedTask(task), /unsupported check type/i);
});

test("validateGeneratedTask rejects stdout checks without a value", () => {
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "stdout_exact" }] }), /stdout_exact.*value|value.*stdout_exact/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "stdout_contains", value: "" }] }), /stdout_contains/i);
});

test("validateGeneratedTask rejects exit_code checks without an integer value", () => {
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "exit_code", value: "zero" }] }), /exit_code/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "exit_code", value: 1.5 }] }), /exit_code/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "exit_code" }] }), /exit_code/i);
  assert.doesNotThrow(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "exit_code", value: 2 }] }));
});

test("validateGeneratedTask rejects file checks without a path", () => {
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "file_exists", value: "x" }] }), /file_exists.*path|path.*file_exists/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "file_contains", value: "x" }] }), /file_contains/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "file_empty", path: "" }] }), /file_empty/i);
  assert.doesNotThrow(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "file_exists", path: "copied.txt" }, { type: "file_empty", path: "log.txt" }] }));
});

test("validateGeneratedTask rejects every supported check type missing its required fields", () => {
  assert.doesNotThrow(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "stdout_exact", value: "out" }] }));
  assert.doesNotThrow(() => validateGeneratedTask({ ...validGeneratedTask(), checks: [{ type: "stdout_contains", value: "out" }] }));
});

test("validateGeneratedTask rejects missing or empty verifierSpec", () => {
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), verifierSpec: "" }), /verifierSpec/i);
  assert.throws(() => validateGeneratedTask({ ...validGeneratedTask(), verifierSpec: undefined }), /verifierSpec/i);
});

test("validateGeneratedTask still rejects verifier leakage in the prompt, including whitespace-obfuscated leaks", () => {
  assert.throws(
    () => validateGeneratedTask({ ...validGeneratedTask(), prompt: "Copy the file. assert copied.txt contains payload" }),
    /verifier leakage/i,
  );
  assert.throws(
    () => validateGeneratedTask({ ...validGeneratedTask(), prompt: "Copy the file. The evaluator will assert copied.txt  contains\npayload when done." }),
    /verifier leakage/i,
  );
  assert.doesNotThrow(() => validateGeneratedTask({ ...validGeneratedTask(), prompt: "Copy the input file to the output file." }));
});

test("generation path rejects invalid tasks with a rule-naming error", async () => {
  const broken = validGeneratedTask();
  delete (broken as Record<string, unknown>).setupFiles;
  const client = { async generate(_prompt: string) {
    return JSON.stringify({ tasks: [broken] });
  } };
  await assert.rejects(() => generateShellTasks(profile, client, 1), /setupFiles/i);
});
