import { createHash } from "node:crypto";
import type { DiagnosticCase, ExecutionResult, Track } from "./types.ts";

export interface PublicQuestion {
  id: string;
  category: DiagnosticCase["category"];
  difficulty: DiagnosticCase["difficulty"];
  prompt: string;
  sequence: number;
}

export interface ExternalAttemptRecord {
  session_id: string;
  model: string;
  provider: string;
  track: Track;
  case_id: string;
  attempt: number;
  response: string;
  execution: ExecutionResult;
  runner: {
    shell: string;
    shellVersion: string;
    sandbox: string;
    temperature?: number;
    seed?: number;
  };
}

const EXECUTION_STATUSES = new Set<ExecutionResult["status"]>([
  "passed",
  "failed",
  "timed-out",
  "sandbox-unavailable",
  "blocked",
]);
const SYNTAX_STATUSES = new Set<ExecutionResult["syntax"]>(["passed", "failed", "not-run"]);
const VERIFICATION_STATUSES = new Set<ExecutionResult["verification"]>(["passed", "failed", "not-run"]);

export function publicQuestion(item: DiagnosticCase, sequence = 0): PublicQuestion {
  return {
    id: item.id,
    category: item.category,
    difficulty: item.difficulty,
    prompt: item.prompt,
    sequence,
  };
}

export function attemptKey(record: Pick<ExternalAttemptRecord, "session_id" | "track" | "case_id" | "attempt">): string {
  return `${record.session_id}\u001f${record.track}\u001f${record.case_id}\u001f${record.attempt}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExecution(value: unknown): asserts value is ExecutionResult {
  if (!isRecord(value)) throw new Error("incomplete execution record");
  if (!EXECUTION_STATUSES.has(value.status as ExecutionResult["status"])) throw new Error("invalid execution status");
  if (!SYNTAX_STATUSES.has(value.syntax as ExecutionResult["syntax"])) throw new Error("invalid syntax status");
  if (!VERIFICATION_STATUSES.has(value.verification as ExecutionResult["verification"])) throw new Error("invalid verification status");
  if (value.status === "passed" && (value.syntax !== "passed" || value.verification !== "passed")) {
    throw new Error("inconsistent execution record: status passed requires passed syntax and verification");
  }
  if ((value.status === "blocked" || value.status === "sandbox-unavailable") && (value.syntax === "passed" || value.verification === "passed")) {
    throw new Error(`inconsistent execution record: ${value.status} status cannot report passed syntax or verification`);
  }
  if (typeof value.stdout !== "string" || typeof value.stderr !== "string") throw new Error("execution output must be strings");
  if (typeof value.durationMs !== "number" || value.durationMs < 0) throw new Error("invalid execution duration");
  if (!Array.isArray(value.findings)) throw new Error("execution findings must be an array");
}

export function validateAttemptRecord(
  value: unknown,
  knownCaseIds: Set<string>,
  seenKeys?: Set<string>,
): asserts value is ExternalAttemptRecord {
  if (!isRecord(value)) throw new Error("attempt must be an object");
  const record = value as Partial<ExternalAttemptRecord>;
  if (typeof record.case_id !== "string" || !knownCaseIds.has(record.case_id)) throw new Error("unknown case_id");
  if (typeof record.session_id !== "string" || record.session_id.length === 0) throw new Error("incomplete session_id");
  if (typeof record.model !== "string" || record.model.length === 0) throw new Error("incomplete model");
  if (typeof record.provider !== "string" || record.provider.length === 0) throw new Error("incomplete provider");
  if (record.track !== "raw" && record.track !== "pi-tools") throw new Error("unsupported track");
  if (!Number.isInteger(record.attempt) || (record.attempt as number) < 1) throw new Error("attempt must be a positive integer");
  if (typeof record.response !== "string" || record.response.length === 0) throw new Error("incomplete response");
  assertExecution(record.execution);
  if (!isRecord(record.runner)) throw new Error("incomplete runner metadata");
  if (typeof record.runner.shell !== "string" || typeof record.runner.shellVersion !== "string" || typeof record.runner.sandbox !== "string") {
    throw new Error("incomplete runner metadata");
  }
  const key = attemptKey(record as ExternalAttemptRecord);
  if (seenKeys?.has(key)) throw new Error(`duplicate attempt: ${key}`);
}

export type TeacherVerification = "passed" | "failed";

export interface TeacherRecord {
  task_id: string;
  task: { prompt: string } & Record<string, unknown>;
  response: string;
  verification: TeacherVerification;
  execution: Record<string, unknown>;
  failureLabels: string[];
  provenance: {
    session_id: string;
    model: string;
    provider: string;
    track: Track;
    attempt: number;
  };
  content_hash: string;
}

const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function normalizeTeacherText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function teacherContentHash(taskText: string, response: string): string {
  const task = normalizeTeacherText(taskText);
  const answer = normalizeTeacherText(response);
  const payload = `{"response": ${JSON.stringify(answer)}, "task": ${JSON.stringify(task)}}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function validateTeacherRecord(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ["teacher record must be an object"];
  const record = value as Partial<TeacherRecord>;

  if (typeof record.task_id !== "string" || record.task_id.length === 0) problems.push("task_id must be a non-empty string");

  const task = record.task;
  let taskPrompt: string | undefined;
  if (!isRecord(task)) {
    problems.push("task must be an object");
  } else if (typeof task.prompt !== "string" || task.prompt.length === 0) {
    problems.push("task.prompt must be a non-empty string");
  } else {
    taskPrompt = task.prompt;
  }

  if (typeof record.response !== "string" || record.response.trim().length === 0) problems.push("response must be a non-empty string");
  if (record.verification !== "passed" && record.verification !== "failed") problems.push('verification must be "passed" or "failed"');
  if (!isRecord(record.execution)) problems.push("execution must be an object");
  if (!Array.isArray(record.failureLabels) || !record.failureLabels.every((label) => typeof label === "string")) {
    problems.push("failureLabels must be an array of strings");
  }

  const provenance = record.provenance;
  if (!isRecord(provenance)) {
    problems.push("provenance must be an object");
  } else {
    const p = provenance as Partial<TeacherRecord["provenance"]>;
    if (typeof p.session_id !== "string" || p.session_id.length === 0) problems.push("provenance.session_id must be a non-empty string");
    if (typeof p.model !== "string" || p.model.length === 0) problems.push("provenance.model must be a non-empty string");
    if (typeof p.provider !== "string" || p.provider.length === 0) problems.push("provenance.provider must be a non-empty string");
    if (p.track !== "raw" && p.track !== "pi-tools") problems.push('provenance.track must be "raw" or "pi-tools"');
    if (!Number.isInteger(p.attempt) || (p.attempt as number) < 1) problems.push("provenance.attempt must be an integer >= 1");
  }

  if (typeof record.content_hash !== "string" || !CONTENT_HASH_PATTERN.test(record.content_hash)) {
    problems.push("content_hash must be 64 lowercase hex characters");
  } else if (taskPrompt !== undefined && typeof record.response === "string") {
    const expected = teacherContentHash(taskPrompt, record.response);
    if (record.content_hash !== expected) problems.push(`content_hash mismatch: expected ${expected}`);
  }

  return problems;
}
