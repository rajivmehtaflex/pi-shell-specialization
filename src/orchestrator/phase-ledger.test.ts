import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInitialLedger,
  markPhaseDone,
  markPhaseWorking,
  readLedger,
  recoverStaleWorking,
  resetFailedPhase,
  writeLedgerAtomic,
} from "./phase-ledger.ts";
import { createArtifactManifest, recordArtifact } from "./artifact-manifest.ts";

test("initial ledger contains every phase and dry-run mode", () => {
  const ledger = createInitialLedger({ mode: "dry-run", now: "2026-08-19T00:00:00Z" });
  assert.equal(ledger.remote, "https://huggingface.co/rajivmehtapy/pi-shell-specialization");
  assert.equal(ledger.mode, "dry-run");
  assert.ok(ledger.phases.some((phase) => phase.id === "P2.6b"));
  assert.ok(ledger.phases.every((phase) => phase.status === "pending"));
});

test("ledger records dual-GPU topology only for AsyncGRPO", () => {
  const ledger = createInitialLedger({ mode: "live" });
  const grpo = ledger.phases.find((phase) => phase.id === "P2.6")!;
  const sft = ledger.phases.find((phase) => phase.id === "P2.3")!;
  assert.equal(grpo.computeMode, "dual-gpu-async-grpo");
  assert.equal(grpo.requiredGpuCount, 2);
  assert.equal(sft.computeMode, "single-gpu");
  assert.equal(sft.requiredGpuCount, 1);
});

test("ledger marks phases working and done with checkpoints", () => {
  const ledger = createInitialLedger({ mode: "live", now: "2026-08-19T00:00:00Z" });
  const working = markPhaseWorking(ledger, "P2.0", { jobId: "modal-1", totalInputs: 10, now: "2026-08-19T00:01:00Z" });
  assert.equal(working.phases.find((p) => p.id === "P2.0")?.status, "working");
  const done = markPhaseDone(working, "P2.0", {
    artifacts: ["data/prompts.jsonl"],
    artifactHashes: { "data/prompts.jsonl": "abc" },
    commit: "commit-1",
    now: "2026-08-19T00:02:00Z",
    nextAction: "P2.1",
  });
  const phase = done.phases.find((p) => p.id === "P2.0")!;
  assert.equal(phase.status, "done");
  assert.equal(phase.commit, "commit-1");
  assert.deepEqual(phase.artifacts, ["data/prompts.jsonl"]);
});

test("atomic ledger write/read and stale working recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "phase-ledger-test-"));
  const path = join(root, "state", "phase-ledger.json");
  const ledger = markPhaseWorking(createInitialLedger({ mode: "live" }), "P2.1", { jobId: "job-1" });
  await writeLedgerAtomic(path, ledger);
  const loaded = await readLedger(path);
  assert.equal(loaded.phases.find((p) => p.id === "P2.1")?.jobId, "job-1");
  const recovered = recoverStaleWorking(loaded);
  assert.equal(recovered.phases.find((p) => p.id === "P2.1")?.status, "interrupted");
  assert.match(await readFile(path, "utf8"), /phase|schemaVersion/i);
});

test("resetFailedPhase re-enables only failed phases and clears the stale job", () => {
  let ledger = markPhaseWorking(createInitialLedger({ mode: "live" }), "P2.1", { jobId: "job-1" });
  const failedPhase = ledger.phases.find((p) => p.id === "P2.1")!;
  failedPhase.status = "failed";
  failedPhase.error = "remote job failed: job-1";
  failedPhase.nextAction = "inspect remote logs and rerun explicitly";
  ledger = resetFailedPhase(ledger, "P2.1", { now: "2026-08-19T00:03:00Z" });
  const reset = ledger.phases.find((p) => p.id === "P2.1")!;
  assert.equal(reset.status, "pending");
  assert.equal(reset.jobId, undefined);
  assert.equal(reset.error, undefined);
  assert.equal(reset.nextAction, undefined);
  assert.throws(() => resetFailedPhase(ledger, "P2.1"), /not failed/);
  assert.throws(() => resetFailedPhase(createInitialLedger({ mode: "live" }), "P0"), /not failed/);
});

test("artifact manifest records bytes and SHA-256", async () => {
  const root = await mkdtemp(join(tmpdir(), "artifact-manifest-test-"));
  const file = join(root, "sample.jsonl");
  await writeFile(file, "hello\n", "utf8");
  const manifest = createArtifactManifest("dry-run");
  const updated = await recordArtifact(manifest, file, { phase: "P2.0", storage: "hf-git" });
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].bytes, 6);
  assert.match(updated.artifacts[0].sha256, /^[a-f0-9]{64}$/);
});
