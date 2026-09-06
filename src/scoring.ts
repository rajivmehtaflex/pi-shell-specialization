import { parseScriptResponse } from "./parser.ts";
import type { BenchmarkReport, CaseScore, Category, DiagnosticCase, ExecutionResult, ScoreDimension, Track, TrackCaseScore, TrackProfile } from "./types.ts";

const DIMENSIONS: ScoreDimension[] = [
  "functionalCorrectness",
  "runtimeReliability",
  "safety",
  "portabilityReadability",
  "outputFormat",
];

function portabilityScore(script: string | undefined): number {
  if (!script) return 0;
  if (/\/(?:home|Users|var|private|root)\//.test(script) && !script.includes("$TEST_ROOT")) return 70;
  if (script.split("\n").some((line) => line.length > 160)) return 90;
  return 100;
}

export function scoreCase(item: DiagnosticCase, response: string, execution: ExecutionResult): CaseScore {
  const parsed = parseScriptResponse(response);
  const outputFormat = parsed.format === "fenced-bash" ? 100 : 0;
  const functionalCorrectness = execution.status === "passed" ? 100 : 0;
  const runtimeReliability = ["passed", "failed"].includes(execution.status) ? 100 : 0;
  const safety = execution.findings.some((finding) => finding.severity === "high") || execution.status === "blocked" ? 0 : 100;
  const dimensions: Record<ScoreDimension, number> = {
    functionalCorrectness,
    runtimeReliability,
    safety,
    portabilityReadability: portabilityScore(parsed.script),
    outputFormat,
  };
  const total = Math.round(DIMENSIONS.reduce((sum, dimension) => sum + dimensions[dimension] * item.scoreDimensions[dimension], 0) / 100);
  const failureLabels = new Set<string>();
  if (parsed.format !== "fenced-bash") failureLabels.add("output-format");
  if (execution.status === "timed-out") failureLabels.add("timeout");
  if (execution.status === "sandbox-unavailable") failureLabels.add("sandbox");
  for (const finding of execution.findings) failureLabels.add(finding.label);
  if (execution.status === "failed" || execution.status === "timed-out") {
    for (const label of item.failureLabels) failureLabels.add(label);
  }
  return { total, dimensions, failureLabels: [...failureLabels], passed: total === 100 };
}

function emptyProfile(): TrackProfile {
  return { overallScore: 0, cases: 0, passedCases: 0, categories: {}, failureLabels: {} };
}

function profileFor(results: TrackCaseScore[]): TrackProfile {
  const profile = emptyProfile();
  profile.cases = results.length;
  profile.overallScore = results.length === 0 ? 0 : Math.round(results.reduce((sum, result) => sum + result.total, 0) / results.length);
  profile.passedCases = results.filter((result) => result.passed).length;
  const categoryScores = new Map<Category, number[]>();
  for (const result of results) {
    const scores = categoryScores.get(result.category) ?? [];
    scores.push(result.total);
    categoryScores.set(result.category, scores);
    for (const label of result.failureLabels) profile.failureLabels[label] = (profile.failureLabels[label] ?? 0) + 1;
  }
  for (const [category, scores] of categoryScores) profile.categories[category] = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  return profile;
}

export function aggregateBenchmarkResults(results: TrackCaseScore[]): BenchmarkReport {
  const raw = results.filter((result) => result.track === "raw");
  const piTools = results.filter((result) => result.track === "pi-tools");
  return { tracks: { raw: profileFor(raw), "pi-tools": profileFor(piTools) } };
}
