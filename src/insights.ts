import { BENCHMARK_CASES } from "./cases.ts";
import { parseScriptResponse } from "./parser.ts";
import { scoreCase } from "./scoring.ts";
import type { ExternalAttemptRecord } from "./diagnostic-types.ts";
import type { Category, CaseScore, DiagnosticCase } from "./types.ts";

export interface DifficultyInsight {
  cases: number;
  attempts: number;
  passRate: number;
  averageScore: number;
}

export interface CategoryInsight {
  category: Category;
  cases: number;
  attempts: number;
  passRate: number;
  passAt1: number;
  passAtN: number;
  averageScore: number;
  confidenceInterval: [number, number];
  byDifficulty: Record<string, DifficultyInsight>;
  failureLabels: Record<string, number>;
  capabilityFailures: number;
  protocolFailures: number;
  evaluatorFailures: number;
  confidence: "insufficient" | "tentative" | "supported";
  verdict: "strong" | "borderline" | "weak";
}

export interface WeaknessInsight {
  category: Category;
  label: string;
  evidenceCount: number;
  affectedCases: string[];
  recommendation: string;
}

export interface WeaknessProfile {
  model: string;
  track: string;
  categories: CategoryInsight[];
  weaknesses: WeaknessInsight[];
  curriculumMix: Record<string, number>;
  recommendedStage2Priority: WeaknessInsight[];
  doNotTrainYet: string[];
}

export interface ProfileOptions {
  model?: string;
  track?: string;
}

export interface ProfileComparison {
  category: Category;
  studentPassRate: number;
  teacherPassRate: number;
  gap: number;
  classification: "high-value-distillation-target" | "teacher-or-task-quality-check" | "no-priority";
}

interface EvaluatedAttempt {
  record: ExternalAttemptRecord;
  item: DiagnosticCase;
  score: CaseScore;
  protocolFailure: boolean;
  evaluatorFailure: boolean;
  capabilityFailure: boolean;
}

const CASES_BY_ID = new Map(BENCHMARK_CASES.map((item) => [item.id, item]));

const RECOMMENDATIONS: Record<string, string> = {
  "word-splitting": "Add filenames with spaces/newlines, quoted expansions, and arrays with multi-word elements.",
  glob: "Add literal wildcard data and leading-dash arguments; require safe -- delimiters.",
  "pipeline-status": "Add pipefail, PIPESTATUS, partial pipeline failure, and error propagation tasks.",
  "trap-cleanup": "Add EXIT/ERR traps, temporary files, cleanup on failure, and signal-path tasks.",
  "hardcoded-path": "Add discovery-first tasks and require $TEST_ROOT-relative behavior.",
  injection: "Add untrusted values as data, command allowlists, path traversal, and metacharacter tasks.",
  arrays: "Add Bash arrays containing spaces/newlines and transformations that preserve element boundaries.",
  "parameter-expansion": "Add unset, empty, default-value, and strict-mode parameter cases.",
};

export function wilsonInterval(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials === 0) return [0, 0];
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) / trials) + (z * z / (4 * trials * trials)));
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function classify(record: ExternalAttemptRecord, score: CaseScore): Pick<EvaluatedAttempt, "protocolFailure" | "evaluatorFailure" | "capabilityFailure"> {
  const parsed = parseScriptResponse(record.response);
  const protocolFailure = parsed.format !== "fenced-bash";
  const error = record.execution.error ?? "";
  const evaluatorFailure = record.execution.status === "sandbox-unavailable" || /fixture\s+setup|evaluator|verifier\s+unavailable/i.test(error);
  return { protocolFailure, evaluatorFailure, capabilityFailure: !protocolFailure && !evaluatorFailure && !score.passed };
}

function firstAttempts(records: ExternalAttemptRecord[]): Map<string, ExternalAttemptRecord> {
  const grouped = new Map<string, ExternalAttemptRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.case_id) ?? [];
    list.push(record);
    grouped.set(record.case_id, list);
  }
  return new Map([...grouped.entries()].map(([caseId, list]) => [caseId, [...list].sort((a, b) => a.attempt - b.attempt)[0]]));
}

function rate(successes: number, trials: number): number {
  return trials === 0 ? 0 : successes / trials;
}

function verdict(passRate: number): CategoryInsight["verdict"] {
  if (passRate >= 0.8) return "strong";
  if (passRate >= 0.6) return "borderline";
  return "weak";
}

function failureEvidence(attempts: EvaluatedAttempt[]): { counts: Record<string, number>; cases: Map<string, Set<string>>; attempts: Map<string, Set<string>> } {
  const counts: Record<string, number> = {};
  const cases = new Map<string, Set<string>>();
  const attemptKeys = new Map<string, Set<string>>();
  for (const attempt of attempts) {
    if (!attempt.capabilityFailure) continue;
    for (const label of attempt.score.failureLabels) {
      counts[label] = (counts[label] ?? 0) + 1;
      const affected = cases.get(label) ?? new Set<string>();
      affected.add(attempt.record.case_id);
      cases.set(label, affected);
      const keys = attemptKeys.get(label) ?? new Set<string>();
      keys.add(`${attempt.record.case_id}:${attempt.record.attempt}`);
      attemptKeys.set(label, keys);
    }
  }
  return { counts, cases, attempts: attemptKeys };
}

function buildCurriculumMix(categories: CategoryInsight[]): Record<string, number> {
  if (categories.length === 0) return {};
  const base = 10 / categories.length;
  const priorities = categories.map((category) => {
    const hardFailureRate = 1 - (category.byDifficulty.hard?.passRate ?? category.passRate);
    const largestLabelCount = Math.max(0, ...Object.values(category.failureLabels));
    const repeatedLabelRate = Math.min(1, largestLabelCount / Math.max(1, category.cases));
    const priority = (1 - category.passRate) * (1 + Math.min(1, hardFailureRate)) * (1 + repeatedLabelRate);
    return { category: category.category, priority };
  });
  const sum = priorities.reduce((total, item) => total + item.priority, 0);
  const result: Record<string, number> = {};
  let assigned = 0;
  priorities.forEach((item, index) => {
    const value = index === priorities.length - 1
      ? Math.round((100 - assigned) * 100) / 100
      : Math.round((base + (sum === 0 ? 90 / priorities.length : (90 * item.priority) / sum)) * 100) / 100;
    result[item.category] = value;
    assigned += value;
  });
  return result;
}

export function withCurriculumAnalysis(profile: WeaknessProfile): WeaknessProfile {
  const curriculumMix = buildCurriculumMix(profile.categories);
  const recommendedStage2Priority = [...profile.weaknesses].sort((a, b) => b.evidenceCount - a.evidenceCount);
  const doNotTrainYet = profile.categories
    .filter((category) => category.protocolFailures > category.capabilityFailures || category.evaluatorFailures > category.capabilityFailures)
    .map((category) => `${category.category}: fix protocol/evaluator evidence before training`);
  return { ...profile, curriculumMix, recommendedStage2Priority, doNotTrainYet };
}

export function compareProfiles(student: WeaknessProfile, teacher: WeaknessProfile): ProfileComparison[] {
  const categories = [...new Set([...student.categories.map((item) => item.category), ...teacher.categories.map((item) => item.category)])];
  return categories.map((category) => {
    const studentInsight = student.categories.find((item) => item.category === category);
    const teacherInsight = teacher.categories.find((item) => item.category === category);
    const studentPassRate = studentInsight?.passRate ?? 0;
    const teacherPassRate = teacherInsight?.passRate ?? 0;
    const gap = teacherPassRate - studentPassRate;
    const classification = studentPassRate < 0.6 && teacherPassRate >= 0.8
      ? "high-value-distillation-target"
      : studentPassRate < 0.6 && teacherPassRate < 0.6
        ? "teacher-or-task-quality-check"
        : "no-priority";
    return { category, studentPassRate, teacherPassRate, gap, classification };
  });
}

export function buildWeaknessProfile(records: ExternalAttemptRecord[], options: ProfileOptions = {}): WeaknessProfile {
  const evaluated = records.map((record) => {
    const item = CASES_BY_ID.get(record.case_id);
    if (!item) throw new Error(`unknown case id: ${record.case_id}`);
    const score = scoreCase(item, record.response, record.execution);
    return { record, item, score, ...classify(record, score) };
  });
  const first = firstAttempts(records);
  const firstEvaluated = [...first.values()].map((record) => evaluated.find((attempt) => attempt.record === record)!);
  const categories = [...new Set(firstEvaluated.map((attempt) => attempt.item.category))];
  const categoryInsights = categories.map((category): CategoryInsight => {
    const all = evaluated.filter((attempt) => attempt.item.category === category);
    const unique = firstEvaluated.filter((attempt) => attempt.item.category === category);
    const capability = unique.filter((attempt) => !attempt.protocolFailure && !attempt.evaluatorFailure);
    const successes = capability.filter((attempt) => attempt.score.passed).length;
    const passRate = rate(successes, capability.length);
    const laterSuccesses = new Set(
      all.filter((attempt) => !attempt.protocolFailure && !attempt.evaluatorFailure && attempt.score.passed).map((attempt) => attempt.record.case_id),
    ).size;
    const evidence = failureEvidence(all);
    const repeatedLabel = [...evidence.cases.values()].some((affected) => affected.size >= 2) || [...evidence.attempts.values()].some((keys) => keys.size >= 2);
    const repeatedCaseFailure = [...new Set(all.map((attempt) => attempt.record.case_id))].some((caseId) =>
      all.filter((attempt) => attempt.record.case_id === caseId && attempt.capabilityFailure).length >= 2,
    );
    const byDifficulty: Record<string, DifficultyInsight> = {};
    for (const attempt of capability) {
      const key = attempt.item.difficulty;
      const current = byDifficulty[key] ?? { cases: 0, attempts: 0, passRate: 0, averageScore: 0 };
      current.cases += 1;
      current.attempts += 1;
      current.passRate += attempt.score.passed ? 1 : 0;
      current.averageScore += attempt.score.total;
      byDifficulty[key] = current;
    }
    for (const value of Object.values(byDifficulty)) {
      value.passRate = rate(value.passRate, value.cases);
      value.averageScore = value.cases === 0 ? 0 : Math.round(value.averageScore / value.cases);
    }
    return {
      category,
      cases: unique.length,
      attempts: all.length,
      passRate,
      passAt1: passRate,
      passAtN: rate(laterSuccesses, capability.length),
      averageScore: capability.length === 0 ? 0 : Math.round(capability.reduce((sum, attempt) => sum + attempt.score.total, 0) / capability.length),
      confidenceInterval: wilsonInterval(successes, capability.length),
      byDifficulty,
      failureLabels: evidence.counts,
      capabilityFailures: capability.filter((attempt) => attempt.capabilityFailure).length,
      protocolFailures: unique.filter((attempt) => attempt.protocolFailure).length,
      evaluatorFailures: unique.filter((attempt) => attempt.evaluatorFailure).length,
      confidence: capability.length >= 4 ? "supported" : "insufficient",
      verdict: verdict(passRate),
    };
  });

  const weaknesses: WeaknessInsight[] = [];
  for (const categoryInsight of categoryInsights) {
    if (categoryInsight.confidence !== "supported") continue;
    const categoryAttempts = evaluated.filter((attempt) => attempt.item.category === categoryInsight.category);
    const evidence = failureEvidence(categoryAttempts);
    for (const [label, count] of Object.entries(evidence.counts)) {
      const affectedCases = [...(evidence.cases.get(label) ?? new Set<string>())];
      const repeated = affectedCases.length >= 2 || (evidence.attempts.get(label)?.size ?? 0) >= 2;
      if (!repeated) continue;
      weaknesses.push({
        category: categoryInsight.category,
        label,
        evidenceCount: count,
        affectedCases,
        recommendation: RECOMMENDATIONS[label] ?? `Generate additional verified teacher examples targeting ${label}.`,
      });
    }
  }

  const model = options.model ?? records[0]?.model ?? "unknown";
  const track = options.track ?? records[0]?.track ?? "unknown";
  return withCurriculumAnalysis({
    model,
    track,
    categories: categoryInsights,
    weaknesses,
    curriculumMix: {},
    recommendedStage2Priority: [],
    doNotTrainYet: [],
  });
}
