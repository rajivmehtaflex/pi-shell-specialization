import { BENCHMARK_CASES } from "./cases.ts";
import { publicQuestion, type PublicQuestion } from "./diagnostic-types.ts";

export function exportPublicQuestions(): PublicQuestion[] {
  return BENCHMARK_CASES.map((item, index) => publicQuestion(item, index + 1));
}

export function renderPublicQuestionsMarkdown(questions = exportPublicQuestions()): string {
  const lines = [
    "# Shell-Scripting Capability Probe — 60 Questions",
    "",
    "> Ask each question in a fresh model context. Require exactly one `bash` fenced code block and no explanation.",
    "",
  ];
  let previousCategory: string | undefined;
  for (const question of questions) {
    if (question.category !== previousCategory) {
      previousCategory = question.category;
      lines.push(`## ${question.category}`, "");
    }
    lines.push(
      `### ${question.sequence}. \`${question.id}\` — ${question.difficulty}`,
      "",
      question.prompt,
      "",
    );
  }
  return `${lines.join("\n").trim()}\n`;
}
