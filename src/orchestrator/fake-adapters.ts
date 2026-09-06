import { createHash } from "node:crypto";
import { teacherContentHash } from "../diagnostic-types.ts";
import { CATEGORY_NAMES } from "../types.ts";

export interface DryRunCalls {
  teacher: number;
  network: number;
  gpu: number;
  push: number;
  remoteJobs: number;
}

export interface GeneratedDryRunTask {
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

const DIFFICULTIES = ["easy", "medium", "hard"] as const;

/**
 * Deterministic task factory: task N derives from its index via category
 * rotation and seeded content, so every task is distinct while repeated runs
 * produce byte-identical output.
 */
export class FakeQuestionGenerator {
  generate(count: number): GeneratedDryRunTask[] {
    if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
    return Array.from({ length: count }, (_unused, index) => this.taskAt(index));
  }

  private taskAt(index: number): GeneratedDryRunTask {
    const ordinal = index + 1;
    const id = `dry-run-task-${String(ordinal).padStart(3, "0")}`;
    const category = CATEGORY_NAMES[index % CATEGORY_NAMES.length];
    const inputName = `input ${ordinal}.txt`;
    const payload = `payload-${ordinal}`;
    const copiedName = `copied-${ordinal}.txt`;
    return {
      id,
      category,
      difficulty: DIFFICULTIES[index % DIFFICULTIES.length],
      dialect: "linux-bash5-gnu",
      prompt: `Dry-run scenario ${ordinal}: the file named in $INPUT_FILE contains spaces in its name. Copy it to $TEST_ROOT/${copiedName} exactly, preserving the ${payload} content.`,
      setupFiles: { [inputName]: `${payload}\n` },
      environment: { INPUT_FILE: inputName, COPIED_TARGET: copiedName },
      expectedInvariants: [`copied file ${copiedName} keeps the payload`],
      checks: [{ type: "file_contains", path: copiedName, value: payload }],
      failureLabels: ["word-splitting"],
      verifierSpec: `assert ${copiedName} contains ${payload}`,
      sourceWeaknesses: ["word-splitting"],
      generatorModel: "fake-generator",
    };
  }
}

export interface DryRunEnvelopeRow {
  task_id: string;
  task: GeneratedDryRunTask;
  response: string;
  verification: "passed" | "failed";
  execution: {
    status: string;
    syntax: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    findings: Array<{ label: string; severity: string }>;
  };
  failureLabels: string[];
  provenance: { session_id: string; model: string; provider: string; track: string; attempt: number };
  content_hash: string;
  simulation: true;
}

export class FakeTeacherClient {
  private readonly calls: DryRunCalls;

  constructor(calls: DryRunCalls) {
    this.calls = calls;
  }

  async generate(prompt: string): Promise<{ text: string; requestId: string }> {
    this.calls.teacher += 1;
    const tag = createHash("sha256").update(prompt, "utf8").digest("hex").slice(0, 8);
    return {
      requestId: `fake-teacher-request-${String(this.calls.teacher).padStart(3, "0")}`,
      text: `\`\`\`bash\n# variant ${tag}\ncp "$INPUT_FILE" "$TEST_ROOT/$COPIED_TARGET"\n\`\`\``,
    };
  }
}

export class FakeVerifier {
  verify(task: GeneratedDryRunTask, response: string): DryRunEnvelopeRow {
    return {
      task_id: task.id,
      task,
      response,
      verification: "passed",
      execution: {
        status: "passed",
        syntax: "passed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 0,
        findings: [],
      },
      failureLabels: task.failureLabels,
      provenance: {
        session_id: `dry-run-verify-${task.id}`,
        model: "fake-teacher",
        provider: "dry-run",
        track: "raw",
        attempt: 1,
      },
      content_hash: teacherContentHash(task.prompt, response),
      simulation: true,
    };
  }
}

export interface DryRunJobSpec {
  phase: string;
  command: string;
  gpu: string;
  timeoutSeconds: number;
  estimatedCostUsd: number;
}

/** Mirrors the runtime-config phase-command contract: GPU specs must declare an explicit count prefix. */
function requireGpuCountPrefix(spec: DryRunJobSpec): number {
  const match = /^\s*(\d+)/.exec(spec.gpu);
  if (!match) throw new Error(`phase ${spec.phase} gpu "${spec.gpu}" does not declare a GPU count (prefix it, e.g. "1xL4")`);
  return Number(match[1]);
}

export class FakeRemoteExecutor {
  private readonly calls: DryRunCalls;

  constructor(calls: DryRunCalls) {
    this.calls = calls;
  }

  launch(spec: DryRunJobSpec): { id: string; phase: string; status: "done"; gpu: string; simulation: true } {
    if (!spec.phase || !spec.command || !spec.gpu || spec.timeoutSeconds < 1 || spec.estimatedCostUsd < 0) {
      throw new Error(`invalid remote job spec for ${spec.phase}`);
    }
    requireGpuCountPrefix(spec);
    this.calls.remoteJobs += 1;
    return { id: `dry-run-${spec.phase}`, phase: spec.phase, status: "done", gpu: spec.gpu, simulation: true };
  }
}
