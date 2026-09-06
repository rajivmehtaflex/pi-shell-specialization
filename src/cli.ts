import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BENCHMARK_CASES, validateBenchmarkCases } from "./cases.ts";
import { PiInvoker } from "./invoker.ts";
import { OllamaInvoker } from "./ollama.ts";
import { runBenchmark } from "./runner.ts";
import { aggregateBenchmarkResults } from "./scoring.ts";
import { renderMarkdownReport, renderWeaknessProfile } from "./report.ts";
import { exportPublicQuestions, renderPublicQuestionsMarkdown } from "./question-export.ts";
import { startSession } from "./session.ts";
import { buildWeaknessProfile, compareProfiles, type ProfileComparison } from "./insights.ts";
import { importExternalResults } from "./diagnostic-tools.ts";
import { attemptKey, validateAttemptRecord, type ExternalAttemptRecord } from "./diagnostic-types.ts";
import type { ModelInvoker } from "./invoker.ts";
import type { Track, TrackCaseScore } from "./types.ts";

function option(args: string[], name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadImportedRecords(input: string): Promise<ExternalAttemptRecord[]> {
  if (!input.endsWith(".json")) {
    const summary = await importExternalResults(input);
    if (summary.rejected > 0) throw new Error(`invalid input: ${summary.rejected} rejected records`);
    return summary.records;
  }
  const parsed = JSON.parse(await readFile(input, "utf8")) as { records?: unknown[] } | unknown[];
  const values = Array.isArray(parsed) ? parsed : parsed.records ?? [];
  const seen = new Set<string>();
  const records: ExternalAttemptRecord[] = [];
  const knownCaseIds = new Set(BENCHMARK_CASES.map((item) => item.id));
  for (const value of values) {
    validateAttemptRecord(value, knownCaseIds, seen);
    const record = value as ExternalAttemptRecord;
    seen.add(attemptKey(record));
    records.push(record);
  }
  return records;
}

async function exportBundle(outDir: string): Promise<void> {
  const questionsDir = join(outDir, "questions");
  await mkdir(questionsDir, { recursive: true });
  const publicQuestions = exportPublicQuestions();
  await writeJson(join(questionsDir, "shell-questions-60.json"), publicQuestions);
  await writeFile(join(questionsDir, "shell-questions-60-public.md"), renderPublicQuestionsMarkdown(publicQuestions), "utf8");
  const privateCases = BENCHMARK_CASES.map(({ id, category, difficulty, prompt, testFixture, expectedInvariants, timeoutMs, scoreDimensions, failureLabels, tracks }) => ({
    id, category, difficulty, prompt, testFixture, expectedInvariants, timeoutMs, scoreDimensions, failureLabels, tracks,
  }));
  await writeJson(join(questionsDir, "shell-questions-60-private.json"), privateCases);
  await writeFile(join(outDir, "RESULT-SCHEMA.md"), "# External result schema\n\nSubmit one JSON object per line with `session_id`, `model`, `provider`, `track`, `case_id`, `attempt`, `response`, `execution`, and `runner` fields. Import validates records and never executes `response`.\n", "utf8");
  await writeFile(join(outDir, "README.md"), "# External shell benchmark bundle\n\nAsk the public questions in a separate disposable evaluator. Keep private fixtures and verifiers outside the model prompt. Execute generated scripts only in that external sandbox. Import the resulting JSONL into the Pi package for analysis; do not run the model or generated scripts on the analysis machine.\n", "utf8");
}

function printUsage(): void {
  console.log(`pi-shell-specialization

Commands:
  validate                         Validate all cases
  list                             Print case metadata as JSON
  questions --public               Export sanitized model-facing questions
  start --model MODEL --track T    Create a session manifest without model execution
  import-results --input PATH      Validate externally generated JSONL
  report --input PATH --out PATH   Analyze imported records only
  export-bundle --out DIR          Create public/private evaluator bundle
  run --model MODEL --track TRACK  Generate scripts and sandbox them

Options:
  --provider pi|ollama            Model backend (default: pi). ollama targets the local Ollama HTTP API directly
  --model MODEL                   Model id (default: qwen3.5:9b)
  --track raw|pi-tools            Evaluation track (default: raw)
  --cases id1,id2                 Run a subset of case ids
  --limit N                       Run only the first N selected cases (smoke runs)
  --backend auto|bwrap|host-temp  Default: auto (secure backend required)
  --allow-unsafe-host-sandbox     Required only for local host-temp tests
  --pi-sandboxed                  Declare that Pi tool mode has an external sandbox
  --out PATH                      Write the run JSON and Markdown report beside PATH
`);
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const command = args[0] ?? "help";
  if (command === "help" || command === "--help") {
    printUsage();
    return 0;
  }
  if (command === "validate") {
    const errors = validateBenchmarkCases(BENCHMARK_CASES);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      return 1;
    }
    console.log(`valid: ${BENCHMARK_CASES.length} cases`);
    return 0;
  }
  if (command === "list") {
    console.log(JSON.stringify(BENCHMARK_CASES.map(({ id, category, difficulty, prompt, tracks }) => ({ id, category, difficulty, prompt, tracks })), null, 2));
    return 0;
  }
  if (command === "questions") {
    const category = option(args, "--category");
    const difficulty = option(args, "--difficulty");
    const questions = exportPublicQuestions().filter((question) =>
      (!category || question.category === category) && (!difficulty || question.difficulty === difficulty),
    );
    const out = option(args, "--out");
    if (out) {
      if (out.endsWith(".md")) await writeFile(out, renderPublicQuestionsMarkdown(questions), "utf8");
      else await writeJson(out, questions);
    } else {
      console.log(JSON.stringify(questions, null, 2));
    }
    return 0;
  }
  if (command === "start") {
    const model = option(args, "--model", "qwen3.5:9b")!;
    const track = option(args, "--track", "raw") as Track;
    if (track !== "raw" && track !== "pi-tools") throw new Error(`Unsupported track: ${track}`);
    const attempts = Number(option(args, "--attempts", "1"));
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) throw new Error("--attempts must be an integer from 1 to 10");
    const session = startSession(model, track, { attemptsPerQuestion: attempts, id: option(args, "--session-id") });
    const out = option(args, "--out");
    if (out) await writeJson(out, session);
    else console.log(JSON.stringify(session, null, 2));
    return 0;
  }
  if (command === "import-results") {
    const input = option(args, "--input");
    if (!input) throw new Error("--input is required");
    const summary = await importExternalResults(input);
    const out = option(args, "--out", resolve(process.cwd(), "results", "imported.json"))!;
    await writeJson(out, { source: input, records: summary.records, errors: summary.errors });
    console.log(JSON.stringify({ accepted: summary.accepted, rejected: summary.rejected, outputPath: out }, null, 2));
    return summary.rejected === 0 ? 0 : 1;
  }
  if (command === "report") {
    const input = option(args, "--input");
    if (!input) throw new Error("--input is required");
    const records = await loadImportedRecords(input);
    const profile = buildWeaknessProfile(records);
    let comparisons: ProfileComparison[] = [];
    const controlInput = option(args, "--control-input");
    if (controlInput) comparisons = compareProfiles(profile, buildWeaknessProfile(await loadImportedRecords(controlInput)));
    const markdown = renderWeaknessProfile(profile, comparisons);
    const out = option(args, "--out", resolve(process.cwd(), "results", "WEAKNESS-PROFILE.md"))!;
    await mkdir(resolve(out, ".."), { recursive: true });
    await writeFile(out, markdown, "utf8");
    console.log(JSON.stringify({ model: profile.model, track: profile.track, weaknesses: profile.weaknesses.length, outputPath: out }, null, 2));
    return 0;
  }
  if (command === "export-bundle") {
    const out = option(args, "--out");
    if (!out) throw new Error("--out is required");
    await exportBundle(out);
    console.log(`bundle: ${out}`);
    return 0;
  }
  if (command !== "run") {
    printUsage();
    return 2;
  }

  const model = option(args, "--model", "qwen3.5:9b")!;
  const provider = option(args, "--provider", "pi")!;
  if (provider !== "pi" && provider !== "ollama") throw new Error(`Unsupported provider: ${provider}`);
  const track = option(args, "--track", "raw") as Track;
  if (track !== "raw" && track !== "pi-tools") throw new Error(`Unsupported track: ${track}`);
  if (track === "pi-tools" && !args.includes("--pi-sandboxed")) {
    throw new Error("pi-tools requires --pi-sandboxed after configuring an external disposable sandbox for Pi.");
  }
  const selected = option(args, "--cases")?.split(",").map((id) => id.trim()).filter(Boolean);
  let cases = selected ? BENCHMARK_CASES.filter((item) => selected.includes(item.id)) : [...BENCHMARK_CASES];
  if (selected && cases.length !== selected.length) throw new Error("One or more --cases ids are unknown.");
  const limit = option(args, "--limit");
  if (limit !== undefined) {
    const count = Number(limit);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Invalid --limit: ${limit}`);
    cases = cases.slice(0, count);
  }
  const backend = option(args, "--backend", "auto") as "auto" | "bwrap" | "host-temp";
  let invoker: ModelInvoker;
  if (provider === "ollama") {
    invoker = new OllamaInvoker({ model });
  } else {
    invoker = new PiInvoker({ model, track, sandboxed: track === "raw" || args.includes("--pi-sandboxed") });
  }
  const run = await runBenchmark(cases, {
    tracks: [track],
    invokers: { [track]: invoker },
    sandbox: { backend, allowUnsafeHostSandbox: args.includes("--allow-unsafe-host-sandbox") },
  });
  const report = aggregateBenchmarkResults(run.results as TrackCaseScore[]);
  const markdown = renderMarkdownReport(report, model);
  console.log(markdown);
  const out = option(args, "--out");
  if (out) {
    await writeFile(out, JSON.stringify({ model, run, report }, null, 2), "utf8");
    await writeFile(out.replace(/\.[^.]+$/, "") + ".md", markdown, "utf8");
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
