import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createArtifactManifest, recordArtifact, type ArtifactManifest } from "./artifact-manifest.ts";
import { createInitialLedger, markPhaseDone, markPhaseWorking } from "./phase-ledger.ts";
import type { PhaseLedger } from "./phase-types.ts";
import { FakeQuestionGenerator, FakeRemoteExecutor, FakeTeacherClient, FakeVerifier, type DryRunCalls } from "./fake-adapters.ts";

export interface DryRunResult {
  ledger: PhaseLedger;
  manifest: ArtifactManifest;
  calls: DryRunCalls;
  promptCount: number;
  teacherVerifiedCount: number;
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

  const tasks = generator.generate();
  promptCount = tasks.length;
  await complete("P2.0", [
    { path: "data/prompts.jsonl", content: `${JSON.stringify(tasks[0])}\n` },
    { path: "data/synth_rows.jsonl", content: `${JSON.stringify({ id: "synth-smoke-001", taskId: tasks[0].id, simulation: true })}\n` },
  ]);

  const teacherResponse = await teacher.generate(tasks[0].prompt);
  const verified = verifier.verify(tasks[0], teacherResponse.text);
  teacherVerifiedCount = verified.status === "passed" ? 1 : 0;
  await complete("P2.1", [
    { path: "data/teacher_raw.jsonl", content: `${JSON.stringify({ taskId: tasks[0].id, response: teacherResponse.text, requestId: teacherResponse.requestId, simulation: true })}\n` },
    { path: "data/teacher_verified.jsonl", content: `${JSON.stringify({ taskId: tasks[0].id, response: verified.response, verification: verified.status, failureLabels: verified.failureLabels, simulation: true })}\n` },
  ]);

  await complete("P2.2", [
    { path: "data/train.jsonl", content: `${JSON.stringify({ taskId: tasks[0].id, split: "train", simulation: true })}\n` },
    { path: "data/eval.jsonl", content: `${JSON.stringify({ taskId: tasks[0].id, split: "eval", simulation: true })}\n` },
    { path: "artifacts/audit-smoke.json", content: `${JSON.stringify({ valid: true, productionGate: "not-applicable", simulation: true }, null, 2)}\n` },
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
    const job = remote.launch(id);
    await complete(id, [{ path, content: `${JSON.stringify({ phase: id, job, simulation: true }, null, 2)}\n` }]);
  }

  await mkdir(join(options.root, "state"), { recursive: true });
  await writeFile(join(options.root, "state", "phase-ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await writeFile(join(options.root, "state", "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(options.root, "state", "resume.json"), `${JSON.stringify({ mode: "dry-run", nextPhase: null, simulation: true }, null, 2)}\n`, "utf8");
  return { ledger, manifest, calls, promptCount, teacherVerifiedCount };
}
