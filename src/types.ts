export const CATEGORY_NAMES = [
  "Bash syntax and script structure",
  "Quoting, expansion, globbing, and arrays",
  "Files, paths, permissions, and text processing",
  "Pipelines, streams, and command substitution",
  "Error handling, traps, cleanup, and idempotence",
  "Security and command-injection resistance",
  "Debugging and repairing broken scripts",
  "Multi-step Pi terminal workflows",
] as const;

export type Category = (typeof CATEGORY_NAMES)[number];
export type Difficulty = "easy" | "medium" | "hard";
export type Track = "raw" | "pi-tools";
export type ShellDialect = "linux-bash5-gnu";
export type ScoreDimension = keyof ScoreDimensions;

export interface ScoreDimensions {
  functionalCorrectness: number;
  runtimeReliability: number;
  safety: number;
  portabilityReadability: number;
  outputFormat: number;
}

export interface TestFixture {
  setup: string;
  verify: string;
  expectedExitCode?: number;
  arguments?: string[];
  environment?: Record<string, string>;
}

export interface DiagnosticCase {
  id: string;
  category: Category;
  difficulty: Difficulty;
  dialect: ShellDialect;
  prompt: string;
  requiredOutputFormat: "single-bash-fence";
  testFixture: TestFixture;
  expectedInvariants: string[];
  timeoutMs: number;
  scoreDimensions: ScoreDimensions;
  failureLabels: string[];
  tracks: Track[];
}

export interface SafetyFinding {
  label: string;
  severity: "high" | "medium";
  message: string;
}

export interface ExecutionResult {
  status: "passed" | "failed" | "timed-out" | "sandbox-unavailable" | "blocked";
  syntax: "passed" | "failed" | "not-run";
  verification: "passed" | "failed" | "not-run";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  findings: SafetyFinding[];
  error?: string;
}

export interface ParsedScriptResponse {
  format: "fenced-bash" | "fenced-other" | "plain" | "missing" | "ambiguous";
  script?: string;
  error?: string;
}

export interface CaseScore {
  total: number;
  dimensions: Record<ScoreDimension, number>;
  failureLabels: string[];
  passed: boolean;
}

export interface TrackCaseScore extends CaseScore {
  caseId: string;
  category: Category;
  track: Track;
}

export interface TrackProfile {
  overallScore: number;
  cases: number;
  passedCases: number;
  categories: Partial<Record<Category, number>>;
  failureLabels: Record<string, number>;
}

export interface BenchmarkReport {
  tracks: Record<Track, TrackProfile>;
}

export interface SandboxOptions {
  backend?: "auto" | "bwrap" | "host-temp";
  allowUnsafeHostSandbox?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
