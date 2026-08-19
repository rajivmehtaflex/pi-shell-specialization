import { BENCHMARK_CASES } from "./cases.ts";
import { publicQuestion, type PublicQuestion } from "./diagnostic-types.ts";

export const BENCHMARK_VERSION = "shell-benchmark-60-v1";

export interface SessionAttempt {
  caseId: string;
  attempt: number;
  response: string;
  recordedAt: string;
}

export interface DiagnosticSession {
  id: string;
  model: string;
  track: "raw" | "pi-tools";
  benchmarkVersion: string;
  seed: number;
  attemptsPerQuestion: number;
  questionIds: string[];
  nextIndex: number;
  attempts: SessionAttempt[];
  createdAt: string;
}

export interface StartSessionOptions {
  id?: string;
  questionIds?: string[];
  attemptsPerQuestion?: number;
  benchmarkVersion?: string;
  seed?: number;
  createdAt?: string;
}

const CASES_BY_ID = new Map(BENCHMARK_CASES.map((item) => [item.id, item]));

function makeSessionId(): string {
  return `shell-${Date.now().toString(36)}`;
}

export function startSession(
  model: string,
  track: "raw" | "pi-tools",
  options: StartSessionOptions = {},
): DiagnosticSession {
  const questionIds = options.questionIds ? [...options.questionIds] : BENCHMARK_CASES.map((item) => item.id);
  if (questionIds.length === 0) throw new Error("a session needs at least one question");
  if (questionIds.some((id) => !CASES_BY_ID.has(id))) throw new Error("session contains an unknown question id");
  if (new Set(questionIds).size !== questionIds.length) throw new Error("session question ids must be unique");
  const attemptsPerQuestion = options.attemptsPerQuestion ?? 1;
  if (!Number.isInteger(attemptsPerQuestion) || attemptsPerQuestion < 1) throw new Error("attemptsPerQuestion must be a positive integer");
  return {
    id: options.id ?? makeSessionId(),
    model,
    track,
    benchmarkVersion: options.benchmarkVersion ?? BENCHMARK_VERSION,
    seed: options.seed ?? 42,
    attemptsPerQuestion,
    questionIds,
    nextIndex: 0,
    attempts: [],
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

export function nextQuestion(session: DiagnosticSession): PublicQuestion | null {
  const caseId = session.questionIds[session.nextIndex];
  if (!caseId) return null;
  const item = CASES_BY_ID.get(caseId);
  if (!item) throw new Error(`session references unknown question id: ${caseId}`);
  return publicQuestion(item, session.nextIndex + 1);
}

export function recordResponse(
  session: DiagnosticSession,
  caseId: string,
  response: string,
  attempt: number,
  recordedAt = new Date().toISOString(),
): DiagnosticSession {
  if (!CASES_BY_ID.has(caseId)) throw new Error(`unknown question id: ${caseId}`);
  if (session.nextIndex >= session.questionIds.length) throw new Error("session is complete");
  if (session.questionIds[session.nextIndex] !== caseId) throw new Error("response is not for the current question/order");
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > session.attemptsPerQuestion) throw new Error("attempt exceeds session limit");
  if (response.length === 0) throw new Error("response must not be empty");
  if (session.attempts.some((item) => item.caseId === caseId && item.attempt === attempt)) throw new Error("duplicate response attempt");

  const attempts = [...session.attempts, { caseId, attempt, response, recordedAt }];
  const completedAttempts = attempts.filter((item) => item.caseId === caseId).length;
  return {
    ...session,
    attempts,
    nextIndex: completedAttempts >= session.attemptsPerQuestion ? session.nextIndex + 1 : session.nextIndex,
  };
}
