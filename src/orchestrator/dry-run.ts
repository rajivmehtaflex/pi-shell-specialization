import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createArtifactManifest, recordArtifact, type ArtifactManifest } from "./artifact-manifest.ts";
import { datasetCountsFromSplit, evaluateDatasetGate, splitDatasetRows, type DatasetCounts, type DatasetGateResult } from "./data-phase.ts";
import { createInitialLedger, markPhaseDone, markPhaseWorking } from "./phase-ledger.ts";
import type { PhaseLedger } from "./phase-types.ts";
import { validateGeneratedTask } from "./question-generator.ts";
import { FakeQuestionGenerator, FakeRemoteExecutor, FakeTeacherClient, FakeVerifier, type DryRunCalls, type DryRunEnvelopeRow } from "./fake-adapters.ts";

/** Number of distinct synthetic tasks the dry-run generates, splits, and gates. */
export const DRY_RUN_TASK_COUNT = 6;

export interface DryRunResult {
  ledger: PhaseLedger;
  manifest: ArtifactManifest;
  calls: DryRunCalls;
  promptCount: number;
  teacherVerifiedCount: number;
  datasetGate: DatasetGateResult;
  splitCounts: DatasetCounts;
}

export interface DryRunOptions {
  root: string;
  now?: string;
}

async function writeArtifact(root: string, relativePath: string, content: string): Promise<string> {
  const absolute = join(root, relativePath);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content, "utf8");
  return absolute;
}

function jsonl(rows: ReadonlyArray<object>): string {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

export async function runDryRun(options: DryRunOptions): Promise<DryRunResult> {
  const now = options.now ?? new Date().toISOString();
  const calls: DryRunCalls = { teacher: 0, network: 0, gpu: 0, push: 0, remoteJobs: 0 };
  const generator = new FakeQuestionGenerator();
  const teacher = new FakeTeacherClient(calls);
  const verifier = new FakeVerifier();
  const remote = new FakeRemoteExecutor(calls);
  let ledger = createInitialLedger({ mode: "dry-run", now });
  let manifest = createArtifactManifest("dry-run", now);
  let promptCount = 0;
  let teacherVerifiedCount = 0;
  let datasetGate: DatasetGateResult = { passed: false, productionReady: false, failures: [], warnings: [] };
  let splitCounts: DatasetCounts = { mode: "dry-run", train: 0, eval: 0, holdout: 0, balanceDelta: 0 };

  const complete = async (id: string, files: Array<{ path: string; content: string }>): Promise<void> => {
    ledger = markPhaseWorking(ledger, id, { now });
    const phaseEntries: Record<string, string> = {};
    for (const file of files) {
      const absolute = await writeArtifact(options.root, file.path, file.content);
      manifest = await recordArtifact(manifest, absolute, { phase: id, storage: "local", relativePath: file.path, simulation: true, now });
      phaseEntries[file.path] = manifest.artifacts.find((entry) => entry.path === file.path)!.sha256;
    }
    ledger = markPhaseDone(ledger, id, {
      artifacts: files.map((file) => file.path),
      artifactHashes: phaseEntries,
      commit: `dry-run-${id.replaceAll(".", "-")}`,
      nextAction: "continue dry-run",
      now,
    });
  };

  await complete("P0", [
    { path: "artifacts/weakness_profile.json", content: `${JSON.stringify({ mode: "dry-run", weaknesses: [{ category: "quoting-expansion", labels: ["word-splitting"], priority: "high" }] }, null, 2)}\n` },
  ]);

  const tasks = generator.generate(DRY_RUN_TASK_COUNT);
  // Dry-run fixtures must satisfy the same strict contract as generated tasks.
  for (const task of tasks) validateGeneratedTask(task);
  promptCount = tasks.length;
  await complete("P2.0", [
    { path: "data/prompts.jsonl", content: jsonl(tasks) },
    { path: "data/synth_rows.jsonl", content: jsonl(tasks.map((task, index) => ({ id: `synth-smoke-${String(index + 1).padStart(3, "0")}`, taskId: task.id, simulation: true }))) },
  ]);

  const rawRows: Array<{ taskId: string; response: string; requestId: string; simulation: true }> = [];
  const verifiedRows: DryRunEnvelopeRow[] = [];
  for (const task of tasks) {
    const teacherResponse = await teacher.generate(task.prompt);
    rawRows.push({ taskId: task.id, response: teacherResponse.text, requestId: teacherResponse.requestId, simulation: true });
    verifiedRows.push(verifier.verify(task, teacherResponse.text));
  }
  teacherVerifiedCount = verifiedRows.filter((row) => row.verification === "passed").length;
  await complete("P2.1", [
    { path: "data/teacher_raw.jsonl", content: jsonl(rawRows) },
    { path: "data/teacher_verified.jsonl", content: jsonl(verifiedRows) },
  ]);

  // Real split flow (same algorithm as workers/split.py) over the verified
  // envelope rows, then the real dataset gate in dry-run mode.
  const split = splitDatasetRows(verifiedRows, { seed: 42, holdoutCount: 1, trainRatio: 0.7 });
  splitCounts = datasetCountsFromSplit("dry-run", split);
  datasetGate = evaluateDatasetGate(splitCounts);
  const audit = {
    mode: "dry-run",
    gate: "dry-run",
    valid: datasetGate.passed,
    counts: { train: splitCounts.train, eval: splitCounts.eval, holdout: splitCounts.holdout, balanceDelta: splitCounts.balanceDelta },
    productionGate: datasetGate,
    productionReady: false,
    summary: "dry-run — not production: dataset gate ran with smoke thresholds only",
    simulation: true as const,
  };
  await complete("P2.2", [
    { path: "data/teacher_train.jsonl", content: jsonl(split.train) },
    { path: "data/teacher_eval.jsonl", content: jsonl(split.eval) },
    { path: "data/teacher_holdout.jsonl", content: jsonl(split.holdout) },
    { path: "artifacts/audit-smoke.json", content: `${JSON.stringify(audit, null, 2)}\n` },
  ]);

  const remotePhases = [
    ["P2.3", "runs/sft-v1/job.json"],
    ["P2.4", "runs/sft-v1-merged/job.json"],
    ["P2.5", "runs/eval-sft-v1.json"],
    ["P2.6", "runs/grpo-v1/job.json"],
    ["P2.6b", "runs/grpo-v1-merged/job.json"],
    ["P2.7", "runs/serve-64k/job.json"],
    ["P2.8", "runs/provider-final/job.json"],
  ] as const;
  for (const [id, path] of remotePhases) {
    const job = remote.launch({
      phase: id,
      command: `dry-run ${id}`,
      gpu: id === "P2.6" ? "2xL4" : "1xL4",
      timeoutSeconds: 60,
      estimatedCostUsd: 0,
    });
    await complete(id, [{ path, content: `${JSON.stringify({ phase: id, job, simulation: true }, null, 2)}\n` }]);
  }

  await mkdir(join(options.root, "state"), { recursive: true });
  await writeFile(join(options.root, "state", "phase-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await writeFile(join(options.root, "state", "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(options.root, "state", "resume.json"), `${JSON.stringify({ mode: "dry-run", nextPhase: null, simulation: true }, null, 2)}\n`, "utf8");
  return { ledger, manifest, calls, promptCount, teacherVerifiedCount, datasetGate, splitCounts };
}
