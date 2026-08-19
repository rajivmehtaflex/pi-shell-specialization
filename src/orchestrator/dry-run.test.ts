import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDryRun } from "./dry-run.ts";

test("one-prompt dry run completes every phase with no live side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "shell-specialization-dry-run-"));
  const result = await runDryRun({ root, now: "2026-08-19T00:00:00Z" });
  assert.equal(result.ledger.mode, "dry-run");
  assert.ok(result.ledger.phases.every((phase) => phase.status === "done"));
  assert.ok(result.ledger.phases.every((phase) => phase.executionMode === "dry-run"));
  assert.equal(result.calls.network, 0);
  assert.equal(result.calls.gpu, 0);
  assert.equal(result.calls.push, 0);
  assert.equal(result.calls.teacher, 1);
  assert.equal(result.promptCount, 1);
  assert.equal(result.teacherVerifiedCount, 1);
  assert.ok(result.ledger.phases.every((phase) => phase.commit?.startsWith("dry-run-")));
  await access(join(root, "artifacts", "weakness_profile.json"));
  assert.match(await readFile(join(root, "data", "teacher_verified.jsonl"), "utf8"), /word-splitting/);
});
