import test from "node:test";
import assert from "node:assert/strict";
import { exportPublicQuestions, renderPublicQuestionsMarkdown } from "./question-export.ts";

test("exports exactly 60 unique public questions", () => {
  const questions = exportPublicQuestions();
  assert.equal(questions.length, 60);
  assert.equal(new Set(questions.map((question) => question.id)).size, 60);
  assert.deepEqual(Object.keys(questions[0]).sort(), ["category", "difficulty", "id", "prompt", "sequence"]);
});

test("public markdown does not leak fixture or verifier fields", () => {
  const markdown = renderPublicQuestionsMarkdown();
  assert.match(markdown, /# Shell-Scripting Capability Probe/);
  assert.equal((markdown.match(/^### /gm) ?? []).length, 60);
  assert.doesNotMatch(markdown, /testFixture|verification intent|fixture setup|verify:/i);
});
