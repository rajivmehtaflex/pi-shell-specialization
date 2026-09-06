import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDryRun, DRY_RUN_TASK_COUNT } from "./dry-run.ts";
import { validateTeacherRecord } from "../diagnostic-types.ts";

function parseJsonl(content: string): Array<Record<string, unknown>> {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("one-prompt dry run completes every phase with no live side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-specialization-dry-run-"));
  const result = await runDryRun({ root, now: "2026-08-19T00:00:00Z" });
  assert.equal(result.ledger.mode, "dry-run");
  assert.ok(result.ledger.phases.every((phase) => phase.status === "done"));
  assert.ok(result.ledger.phases.every((phase) => phase.executionMode === "dry-run"));
  assert.equal(result.calls.network, 0);
  assert.equal(result.calls.gpu, 0);
  assert.equal(result.calls.push, 0);
  assert.equal(result.calls.teacher, DRY_RUN_TASK_COUNT);
  assert.equal(result.promptCount, DRY_RUN_TASK_COUNT);
  assert.equal(result.teacherVerifiedCount, DRY_RUN_TASK_COUNT);
  assert.ok(result.ledger.phases.every((phase) => phase.commit?.startsWith("dry-run-")));
  await access(join(root, "artifacts", "weakness_profile.json"));
  assert.match(await readFile(join(root, "data", "teacher_verified.jsonl"), "utf8"), /word-splitting/);
});

test("fake generator produces distinct deterministic tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-specialization-dry-run-gen-"));
  const first = await runDryRun({ root, now: "2026-08-19T00:00:00Z" });
  const prompts = parseJsonl(await readFile(join(root, "data", "prompts.jsonl"), "utf8"));
  assert.equal(prompts.length, DRY_RUN_TASK_COUNT);
  const ids = new Set(prompts.map((task) => task.id));
  const promptTexts = new Set(prompts.map((task) => task.prompt));
  const categories = new Set(prompts.map((task) => task.category));
  assert.equal(ids.size, DRY_RUN_TASK_COUNT, "task ids must be unique");
  assert.equal(promptTexts.size, DRY_RUN_TASK_COUNT, "prompts must be unique");
  assert.ok(categories.size > 1, "categories should rotate across tasks");
  assert.ok(first.promptCount === DRY_RUN_TASK_COUNT);
});

test("P2.2 writes train, eval, and holdout splits with distinct envelope rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-specialization-dry-run-split-"));
  await runDryRun({ root, now: "2026-08-19T00:00:00Z" });

  const splits = new Map<string, Array<Record<string, unknown>>>();
  for (const name of ["teacher_train", "teacher_eval", "teacher_holdout"] as const) {
    const rows = parseJsonl(await readFile(join(root, "data", `${name}.jsonl`), "utf8"));
    assert.ok(rows.length >= 1, `${name}.jsonl must contain at least one row`);
    splits.set(name, rows);
  }

  const seenTaskIds = new Set<string>();
  const seenPrompts = new Set<string>();
  for (const [name, rows] of splits) {
    for (const row of rows) {
      const taskId = row.task_id as string;
      assert.ok(taskId, `${name} rows must carry task_id`);
      assert.ok(!seenTaskIds.has(taskId), `task ${taskId} appears in more than one split`);
      seenTaskIds.add(taskId);
      const task = row.task as Record<string, unknown>;
      const prompt = task.prompt as string;
      assert.ok(prompt, `${name} rows must embed a task prompt`);
      assert.ok(!seenPrompts.has(prompt), "row content must be distinct across splits");
      seenPrompts.add(prompt);
      assert.deepEqual(validateTeacherRecord(row), [], `${name} rows must satisfy the canonical envelope contract`);
    }
  }
  assert.equal(seenTaskIds.size, DRY_RUN_TASK_COUNT, "every dry-run task must land in exactly one split");
});

test("P2.2 audit records the real dry-run dataset gate and never claims production readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-specialization-dry-run-gate-"));
  const result = await runDryRun({ root, now: "2026-08-19T00:00:00Z" });

  const audit = JSON.parse(await readFile(join(root, "artifacts", "audit-smoke.json"), "utf8")) as Record<string, unknown>;
  assert.equal(audit.mode, "dry-run");
  assert.equal(audit.gate, "dry-run");
  assert.equal(audit.simulation, true);
  assert.equal(audit.productionReady, false);
  assert.match(String(audit.summary), /dry-run/i);
  assert.match(String(audit.summary), /not production/i);

  const productionGate = audit.productionGate as Record<string, unknown>;
  assert.equal(productionGate.passed, true, "real dry-run gate must pass with one row per split");
  assert.equal(productionGate.productionReady, false);
  assert.deepEqual(productionGate.failures, []);
  assert.ok((productionGate.warnings as string[]).length > 0);

  const counts = audit.counts as Record<string, number>;
  const splitSizes = new Map<string, number>();
  for (const name of ["teacher_train", "teacher_eval", "teacher_holdout"] as const) {
    const rows = parseJsonl(await readFile(join(root, "data", `${name}.jsonl`), "utf8"));
    splitSizes.set(name, rows.length);
  }
  assert.equal(counts.train, splitSizes.get("teacher_train"));
  assert.equal(counts.eval, splitSizes.get("teacher_eval"));
  assert.equal(counts.holdout, splitSizes.get("teacher_holdout"));
  assert.equal(result.datasetGate.passed, true);
  assert.equal(result.datasetGate.productionReady, false);
});

test("dry-run remote launches declare explicit GPU count prefixes and stay simulated", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-specialization-dry-run-gpu-"));
  const result = await runDryRun({ root, now: "2026-08-19T00:00:00Z" });
  assert.equal(result.calls.remoteJobs, 7);

  const sftJob = JSON.parse(await readFile(join(root, "runs", "sft-v1", "job.json"), "utf8")) as { job: { gpu: string; simulation: boolean } };
  assert.equal(sftJob.job.gpu, "1xL4");
  assert.equal(sftJob.job.simulation, true);
  const grpoJob = JSON.parse(await readFile(join(root, "runs", "grpo-v1", "job.json"), "utf8")) as { job: { gpu: string } };
  assert.equal(grpoJob.job.gpu, "2xL4");
});
