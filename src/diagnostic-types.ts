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
