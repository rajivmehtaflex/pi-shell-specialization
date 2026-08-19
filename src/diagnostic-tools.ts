import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BENCHMARK_CASES, CATEGORY_NAMES } from "./cases.ts";
import { attemptKey, validateAttemptRecord, type ExternalAttemptRecord } from "./diagnostic-types.ts";
import { nextQuestion, recordResponse, startSession, type DiagnosticSession } from "./session.ts";
import { exportPublicQuestions } from "./question-export.ts";
import { buildWeaknessProfile, compareProfiles, type ProfileComparison } from "./insights.ts";
import { renderWeaknessProfile } from "./report.ts";

interface ToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: Record<string, any>) => Promise<unknown> | unknown;
}

export interface ToolRegistrar {
  registerTool(tool: ToolRegistration): void;
}

export interface DiagnosticToolOptions {
  sessionsDir?: string;
  importedDir?: string;
  now?: () => string;
}

export interface ImportSummary {
  accepted: number;
  rejected: number;
  errors: Array<{ line: number; message: string }>;
  records: ExternalAttemptRecord[];
  outputPath?: string;
}

const textResult = (value: unknown) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const caseIds = new Set(BENCHMARK_CASES.map((item) => item.id));

function sessionPath(dir: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("invalid session id");
  return join(dir, `${id}.json`);
}

async function saveSession(dir: string, session: DiagnosticSession): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath(dir, session.id), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

async function loadSession(dir: string, id: string, memory: Map<string, DiagnosticSession>): Promise<DiagnosticSession> {
  const cached = memory.get(id);
  if (cached) return cached;
  const session = JSON.parse(await readFile(sessionPath(dir, id), "utf8")) as DiagnosticSession;
  memory.set(id, session);
  return session;
}

export async function importExternalResults(inputPath: string, outputPath?: string): Promise<ImportSummary> {
  const source = await readFile(resolve(inputPath), "utf8");
  const records: ExternalAttemptRecord[] = [];
  const errors: Array<{ line: number; message: string }> = [];
  const seen = new Set<string>();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      validateAttemptRecord(value, caseIds, seen);
      const record = value as ExternalAttemptRecord;
      const key = attemptKey(record);
      seen.add(key);
      records.push(record);
    } catch (error) {
      errors.push({ line: index + 1, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (outputPath) {
    await mkdir(resolve(outputPath, ".."), { recursive: true });
    await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
  }
  return { accepted: records.length, rejected: errors.length, errors, records, outputPath };
}

export function registerDiagnosticTools(pi: ToolRegistrar, options: DiagnosticToolOptions = {}): void {
  const sessionsDir = options.sessionsDir ?? resolve(process.cwd(), "results", "sessions");
  const importedDir = options.importedDir ?? resolve(process.cwd(), "results", "imported");
  const now = options.now ?? (() => new Date().toISOString());
  const sessions = new Map<string, DiagnosticSession>();

  pi.registerTool({
    name: "shell_benchmark_question_list",
    label: "Shell Benchmark Questions",
    description: "List sanitized model-facing shell questions without fixtures or verifiers.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...CATEGORY_NAMES] },
        difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
      },
    },
    async execute(_toolCallId, params) {
      const questions = exportPublicQuestions().filter((question) =>
        (!params.category || question.category === params.category) &&
        (!params.difficulty || question.difficulty === params.difficulty),
      );
      return textResult({ count: questions.length, questions });
    },
  });

  pi.registerTool({
    name: "shell_benchmark_start",
    label: "Start Shell Diagnostic",
    description: "Start a controlled question session; this does not invoke a model or execute scripts.",
    parameters: {
      type: "object",
      required: ["model", "track"],
      properties: {
        model: { type: "string" },
        track: { type: "string", enum: ["raw", "pi-tools"] },
        attempts: { type: "integer", minimum: 1, maximum: 10 },
        session_id: { type: "string" },
      },
    },
    async execute(_toolCallId, params) {
      const session = startSession(params.model, params.track, {
        id: params.session_id,
        attemptsPerQuestion: params.attempts ?? 1,
        createdAt: now(),
      });
      sessions.set(session.id, session);
      await saveSession(sessionsDir, session);
      return textResult({ session, protocol: "Ask each question in a fresh context; return exactly one bash fenced block." });
    },
  });

  pi.registerTool({
    name: "shell_benchmark_next",
    label: "Next Shell Question",
    description: "Return the next sanitized question from an existing shell diagnostic session.",
    parameters: { type: "object", required: ["session_id"], properties: { session_id: { type: "string" } } },
    async execute(_toolCallId, params) {
      const session = await loadSession(sessionsDir, params.session_id, sessions);
      return textResult({ session_id: session.id, question: nextQuestion(session), complete: nextQuestion(session) === null });
    },
  });

  pi.registerTool({
    name: "shell_benchmark_record_response",
    label: "Record Shell Response",
    description: "Record a model response for later external execution; this tool never executes the response.",
    parameters: {
      type: "object",
      required: ["session_id", "case_id", "attempt", "response"],
      properties: {
        session_id: { type: "string" },
        case_id: { type: "string" },
        attempt: { type: "integer", minimum: 1 },
        response: { type: "string" },
      },
    },
    async execute(_toolCallId, params) {
      const session = await loadSession(sessionsDir, params.session_id, sessions);
      const updated = recordResponse(session, params.case_id, params.response, params.attempt, now());
      sessions.set(updated.id, updated);
      await saveSession(sessionsDir, updated);
      return textResult({ accepted: true, session_id: updated.id, case_id: params.case_id, attempt: params.attempt, next: nextQuestion(updated) });
    },
  });

  pi.registerTool({
    name: "shell_benchmark_import_results",
    label: "Import External Shell Results",
    description: "Validate externally generated JSONL results without invoking Bash, Pi, or Ollama.",
    parameters: {
      type: "object",
      required: ["input"],
      properties: { input: { type: "string" }, out: { type: "string" } },
    },
    async execute(_toolCallId, params) {
      const output = params.out ?? join(importedDir, "latest.jsonl");
      const summary = await importExternalResults(params.input, output);
      return textResult({ accepted: summary.accepted, rejected: summary.rejected, errors: summary.errors, outputPath: summary.outputPath });
    },
  });

  pi.registerTool({
    name: "shell_benchmark_weakness_report",
    label: "Shell Weakness Report",
    description: "Analyze validated external results and write an evidence-based weakness profile without executing candidate scripts.",
    parameters: {
      type: "object",
      required: ["input", "out"],
      properties: {
        input: { type: "string" },
        out: { type: "string" },
        control_input: { type: "string" },
      },
    },
    async execute(_toolCallId, params) {
      const summary = await importExternalResults(params.input);
      if (summary.rejected > 0) throw new Error(`cannot report from invalid input: ${summary.rejected} rejected records`);
      const profile = buildWeaknessProfile(summary.records);
      let comparisons: ProfileComparison[] = [];
      if (params.control_input) {
        const control = await importExternalResults(params.control_input);
        if (control.rejected > 0) throw new Error(`cannot compare invalid control input: ${control.rejected} rejected records`);
        comparisons = compareProfiles(profile, buildWeaknessProfile(control.records));
      }
      const markdown = renderWeaknessProfile(profile, comparisons);
      await mkdir(resolve(params.out, ".."), { recursive: true });
      await writeFile(params.out, markdown, "utf8");
      return textResult({ model: profile.model, track: profile.track, weaknesses: profile.weaknesses, curriculumMix: profile.curriculumMix, outputPath: params.out });
    },
  });
}
