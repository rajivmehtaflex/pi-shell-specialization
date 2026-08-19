import type { WeaknessProfile } from "../insights.ts";

export interface GeneratedShellTask {
  id: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  dialect: "linux-bash5-gnu";
  prompt: string;
  setupFiles: Record<string, string>;
  environment: Record<string, string>;
  expectedInvariants: string[];
  checks: Array<{ type: string; path?: string; value?: string; absent?: boolean }>;
  failureLabels: string[];
  verifierSpec: string;
  sourceWeaknesses: string[];
  generatorModel: string;
}

export interface QuestionGenerationClient {
  generate(prompt: string): Promise<string>;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function parseTasks(text: string): unknown[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(trimmed) as unknown;
  if (Array.isArray(value)) return value;
  const object = asObject(value, "response");
  if (!Array.isArray(object.tasks)) throw new Error("response must contain tasks array");
  return object.tasks;
}

export function renderQuestionGenerationPrompt(profile: WeaknessProfile, count: number): string {
  return [
    "Generate shell-script diagnostic tasks as structured JSON.",
    `Target model: ${profile.model}`,
    "Target dialect: Linux Bash 5.x with GNU userland.",
    `Generate exactly ${count} task objects.`,
    `Confirmed weaknesses: ${JSON.stringify(profile.weaknesses)}.` ,
    `Curriculum mix: ${JSON.stringify(profile.curriculumMix)}.`,
    "Each task must include id, category, difficulty, dialect, prompt, setupFiles, environment, expectedInvariants, checks, failureLabels, verifierSpec, sourceWeaknesses, and generatorModel.",
    "The public prompt must not reveal verifierSpec, expected outputs, hidden assertions, or evaluator implementation details.",
    "Do not use network access, privileged commands, or destructive operations.",
    "Return JSON only.",
  ].join("\n");
}

export async function generateShellTasks(
  profile: WeaknessProfile,
  client: QuestionGenerationClient,
  count: number,
): Promise<GeneratedShellTask[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  const tasks = parseTasks(await client.generate(renderQuestionGenerationPrompt(profile, count)));
  if (tasks.length !== count) throw new Error(`expected ${count} tasks, received ${tasks.length}`);
  const ids = new Set<string>();
  return tasks.map((value) => {
    const task = asObject(value, "task");
    const id = task.id;
    if (typeof id !== "string" || !id) throw new Error("task id is required");
    if (ids.has(id)) throw new Error(`duplicate task id: ${id}`);
    ids.add(id);
    if (task.dialect !== "linux-bash5-gnu") throw new Error(`unsupported dialect for ${id}`);
    if (task.difficulty !== "easy" && task.difficulty !== "medium" && task.difficulty !== "hard") throw new Error(`invalid difficulty for ${id}`);
    if (typeof task.category !== "string" || typeof task.prompt !== "string" || typeof task.verifierSpec !== "string" || typeof task.generatorModel !== "string") throw new Error(`incomplete task: ${id}`);
    if (task.verifierSpec && task.prompt.includes(task.verifierSpec)) throw new Error(`verifier leakage in prompt: ${id}`);
    if (!Array.isArray(task.expectedInvariants) || !Array.isArray(task.checks) || !Array.isArray(task.failureLabels) || !Array.isArray(task.sourceWeaknesses)) throw new Error(`invalid task arrays: ${id}`);
    return task as unknown as GeneratedShellTask;
  });
}
