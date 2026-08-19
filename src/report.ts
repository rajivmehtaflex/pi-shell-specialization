import type { WeaknessProfile, ProfileComparison } from "./insights.ts";
import type { BenchmarkReport, Track } from "./types.ts";

function formatProfile(track: Track, profile: BenchmarkReport["tracks"][Track]): string[] {
  const lines = [
    `## ${track}`,
    `Overall score: ${profile.overallScore}% (${profile.passedCases}/${profile.cases} cases passed)`,
    "",
    "| Category | Score |",
    "| --- | ---: |",
  ];
  for (const [category, score] of Object.entries(profile.categories)) lines.push(`| ${category} | ${score}% |`);
  lines.push("", "Failure labels:");
  const labels = Object.entries(profile.failureLabels).sort((a, b) => b[1] - a[1]);
  if (labels.length === 0) lines.push("- none");
  else for (const [label, count] of labels) lines.push(`- ${label}: ${count}`);
  return lines;
}

export function renderMarkdownReport(report: BenchmarkReport, model = "unknown"): string {
  return [`# Shell Benchmark Report`, `Model: ${model}`, "", ...formatProfile("raw", report.tracks.raw), "", ...formatProfile("pi-tools", report.tracks["pi-tools"])].join("\n");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(value === 1 || value === 0 ? 0 : 1)}%`;
}

export function renderWeaknessProfile(profile: WeaknessProfile, comparisons: ProfileComparison[] = []): string {
  const lines = [
    "# Shell Weakness Profile",
    "",
    `Model: ${profile.model}`,
    `Track: ${profile.track}`,
    "",
    "## Category evidence",
    "",
    "| Category | Cases | Attempts | Pass@1 | Pass@N | Avg score | 95% interval | Confidence | Verdict |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |",
  ];
  for (const category of profile.categories) {
    lines.push(`| ${category.category} | ${category.cases} | ${category.attempts} | ${percentage(category.passAt1)} | ${percentage(category.passAtN)} | ${category.averageScore} | ${percentage(category.confidenceInterval[0])}–${percentage(category.confidenceInterval[1])} | ${category.confidence} | ${category.verdict} |`);
  }
  lines.push("", "## Failure evidence", "");
  for (const category of profile.categories) {
    const labels = Object.entries(category.failureLabels).sort((a, b) => b[1] - a[1]);
    lines.push(`### ${category.category}`, "", `Capability failures: ${category.capabilityFailures}; protocol failures: ${category.protocolFailures}; evaluator failures: ${category.evaluatorFailures}`);
    if (labels.length === 0) lines.push("- no capability failure labels");
    else for (const [label, count] of labels) lines.push(`- ${label}: ${count}`);
    lines.push("");
  }
  lines.push("## Confirmed weaknesses", "");
  if (profile.weaknesses.length === 0) lines.push("- None supported by the imported evidence.", "");
  else for (const weakness of profile.weaknesses) {
    lines.push(`- **${weakness.category} / ${weakness.label}** — ${weakness.evidenceCount} evidence events; affected cases: ${weakness.affectedCases.join(", ")}`);
    lines.push(`  Recommendation: ${weakness.recommendation}`);
  }
  lines.push("", "## Recommended Stage-1 distillation mix", "", "| Category | Prompt share |", "| --- | ---: |");
  for (const [category, share] of Object.entries(profile.curriculumMix)) lines.push(`| ${category} | ${share}% |`);
  lines.push("", "## Stage-2 GRPO priority", "");
  if (profile.recommendedStage2Priority.length === 0) lines.push("- No confirmed capability weakness is ready for GRPO prioritization.");
  else for (const weakness of profile.recommendedStage2Priority) lines.push(`- ${weakness.category} / ${weakness.label}: ${weakness.affectedCases.join(", ")}`);
  lines.push("", "## Do not train yet", "");
  if (profile.doNotTrainYet.length === 0) lines.push("- No protocol/evaluator blocker detected.");
  else for (const item of profile.doNotTrainYet) lines.push(`- ${item}`);
  if (comparisons.length > 0) {
    lines.push("", "## Student/control comparison", "", "| Category | Student pass rate | Control pass rate | Gap | Classification |", "| --- | ---: | ---: | ---: | --- |");
    for (const comparison of comparisons) lines.push(`| ${comparison.category} | ${percentage(comparison.studentPassRate)} | ${percentage(comparison.teacherPassRate)} | ${percentage(comparison.gap)} | ${comparison.classification} |`);
  }
  lines.push("", "## Interpretation", "", "Only repeated, machine-verified capability failures should drive teacher-data generation. Output-format, sandbox, fixture, and evaluator failures require harness correction before they become training data.", "");
  return lines.join("\n");
}
