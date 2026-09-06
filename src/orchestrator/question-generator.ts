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

const SUPPORTED_CHECK_TYPES = new Set(["stdout_exact", "stdout_contains", "exit_code", "file_exists", "file_contains", "file_empty"]);
const CHECKS_REQUIRING_VALUE = new Set(["stdout_exact", "stdout_contains", "file_contains"]);
const CHECKS_REQUIRING_PATH = new Set(["file_exists", "file_contains", "file_empty"]);

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integerLike(value: unknown): boolean {
  if (typeof value === "number") return Number.isInteger(value);
  if (typeof value === "string") return /^-?\d+$/.test(value);
  return false;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Strict structural validation for a generated shell task. Throws an Error that
 * names the violated rule so generation failures are actionable. Returns the
 * task typed as GeneratedShellTask once every rule holds.
 */
export function validateGeneratedTask(value: unknown): GeneratedShellTask {
  const task = asObject(value, "task");
  const id = task.id;
  if (typeof id !== "string" || !id) throw new Error("task id is required");
  const invalid = (rule: string): Error => new Error(`invalid task ${id}: ${rule}`);

  if (task.dialect !== "linux-bash5-gnu") throw invalid(`unsupported dialect: ${JSON.stringify(task.dialect ?? null)}; expected "linux-bash5-gnu"`);
  if (task.difficulty !== "easy" && task.difficulty !== "medium" && task.difficulty !== "hard") throw invalid("difficulty must be one of easy, medium, hard");
  if (!nonEmptyString(task.category)) throw invalid("category must be a non-empty string");
  if (!nonEmptyString(task.prompt)) throw invalid("prompt must be a non-empty string");
  if (!nonEmptyString(task.generatorModel)) throw invalid("generatorModel must be a non-empty string");

  if (typeof task.setupFiles !== "object" || task.setupFiles === null || Array.isArray(task.setupFiles)) throw invalid("setupFiles must be an object");
  const setupFiles = task.setupFiles as Record<string, unknown>;
  const setupKeys = Object.keys(setupFiles);
  if (setupKeys.length === 0) throw invalid("setupFiles must be present and non-empty");
  for (const key of setupKeys) {
    if (typeof setupFiles[key] !== "string") throw invalid(`setupFiles.${key} must map to a string value`);
  }

  if (typeof task.environment !== "object" || task.environment === null || Array.isArray(task.environment)) throw invalid("environment must be a string-to-string record");
  for (const [key, environmentValue] of Object.entries(task.environment as Record<string, unknown>)) {
    if (typeof environmentValue !== "string") throw invalid(`environment.${key} must map to a string value`);
  }

  if (!Array.isArray(task.expectedInvariants)) throw invalid("expectedInvariants must be an array");
  if (!Array.isArray(task.failureLabels)) throw invalid("failureLabels must be an array");
  if (!Array.isArray(task.sourceWeaknesses)) throw invalid("sourceWeaknesses must be an array");

  if (!Array.isArray(task.checks) || task.checks.length === 0) throw invalid("checks must be a present, non-empty array");
  for (const rawCheck of task.checks) {
    const check = asObject(rawCheck, `check in task ${id}`);
    const type = check.type;
    if (typeof type !== "string" || !SUPPORTED_CHECK_TYPES.has(type)) {
      throw invalid(`unsupported check type: ${JSON.stringify(type ?? null)}; supported types: ${[...SUPPORTED_CHECK_TYPES].join(", ")}`);
    }
    if (CHECKS_REQUIRING_VALUE.has(type) && !nonEmptyString(check.value)) throw invalid(`${type} check requires a non-empty value`);
    if (type === "exit_code" && !integerLike(check.value)) throw invalid("exit_code check requires an integer value");
    if (CHECKS_REQUIRING_PATH.has(type) && !nonEmptyString(check.path)) throw invalid(`${type} check requires a non-empty path`);
  }

  if (!nonEmptyString(task.verifierSpec)) throw invalid("verifierSpec must be a non-empty string");
  const spec = task.verifierSpec;
  if (task.prompt.includes(spec) || normalizeWhitespace(task.prompt).includes(normalizeWhitespace(spec))) {
    throw new Error(`verifier leakage in prompt: ${id}`);
  }

  return task as unknown as GeneratedShellTask;
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
    const task = validateGeneratedTask(value);
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    return task;
  });
}
