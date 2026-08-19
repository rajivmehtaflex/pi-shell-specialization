export interface DryRunCalls {
  teacher: number;
  network: number;
  gpu: number;
  push: number;
  remoteJobs: number;
}

export interface GeneratedDryRunTask {
  id: string;
  category: "Quoting, expansion, globbing, and arrays";
  difficulty: "medium";
  dialect: "linux-bash5-gnu";
  prompt: string;
  checks: Array<{ type: string; path?: string; value?: string }>;
  failureLabels: string[];
}

export class FakeQuestionGenerator {
  generate(): GeneratedDryRunTask[] {
    return [{
      id: "quoting-smoke-001",
      category: "Quoting, expansion, globbing, and arrays",
      difficulty: "medium",
      dialect: "linux-bash5-gnu",
      prompt: "The file name is stored in $INPUT_FILE and contains a space. Copy that file to $TEST_ROOT/copied.txt while preserving the filename correctly.",
      checks: [{ type: "file_contains", path: "copied.txt", value: "hello shell" }],
      failureLabels: ["word-splitting"],
    }];
  }
}

export class FakeTeacherClient {
  private readonly calls: DryRunCalls;

  constructor(calls: DryRunCalls) {
    this.calls = calls;
  }

  async generate(_prompt: string): Promise<{ text: string; requestId: string }> {
    this.calls.teacher += 1;
    return {
      requestId: "fake-teacher-request-001",
      text: "```bash\ncp \"$INPUT_FILE\" \"$TEST_ROOT/copied.txt\"\n```",
    };
  }
}

export class FakeVerifier {
  verify(_task: GeneratedDryRunTask, response: string): { status: "passed"; failureLabels: string[]; response: string } {
    return { status: "passed", failureLabels: ["word-splitting"], response };
  }
}

export class FakeRemoteExecutor {
  private readonly calls: DryRunCalls;

  constructor(calls: DryRunCalls) {
    this.calls = calls;
  }

  launch(phase: string): { id: string; phase: string; status: "done"; simulation: true } {
    this.calls.remoteJobs += 1;
    return { id: `dry-run-${phase}`, phase, status: "done", simulation: true };
  }
}
