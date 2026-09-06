import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createArtifactManifest, recordArtifact, verifyLedgerArtifacts } from "./artifact-manifest.ts";
import { createInitialLedger, markPhaseDone, markPhaseWorking } from "./phase-ledger.ts";

test("verifyLedgerArtifacts accepts done phases whose files match their recorded hashes", async () => {
  const root = await mkdtemp(join("/tmp", "artifact-verify-ok-"));
  const content = "train,row\n";
  await mkdir(dirname(join(root, "data", "teacher_train.jsonl")), { recursive: true });
  await writeFile(join(root, "data", "teacher_train.jsonl"), content, "utf8");
  const sha = createHash("sha256").update(content).digest("hex");
  let ledger = markPhaseWorking(createInitialLedger({ mode: "live" }), "P2.1");
  ledger = markPhaseDone(ledger, "P2.1", {
    artifacts: ["data/teacher_train.jsonl"],
    artifactHashes: { "data/teacher_train.jsonl": sha },
  });
  assert.deepEqual(await verifyLedgerArtifacts(root, ledger), []);
});

test("verifyLedgerArtifacts reports missing files and hash mismatches with expected and actual digests", async () => {
  const root = await mkdtemp(join("/tmp", "artifact-verify-bad-"));
  const content = "original\n";
  await mkdir(dirname(join(root, "artifacts", "profile.json")), { recursive: true });
  await writeFile(join(root, "artifacts", "profile.json"), content, "utf8");
  const sha = createHash("sha256").update(content).digest("hex");
  let ledger = markPhaseWorking(createInitialLedger({ mode: "live" }), "P0");
  ledger = markPhaseDone(ledger, "P0", {
    artifacts: ["artifacts/profile.json", "data/ghost.jsonl"],
    artifactHashes: { "artifacts/profile.json": sha, "data/ghost.jsonl": "b".repeat(64) },
  });
  await writeFile(join(root, "artifacts", "profile.json"), "tampered\n", "utf8");
  const issues = await verifyLedgerArtifacts(root, ledger);
  assert.equal(issues.length, 2);
  const mismatch = issues.find((issue) => issue.reason === "hash-mismatch");
  assert.equal(mismatch?.phase, "P0");
  assert.equal(mismatch?.path, "artifacts/profile.json");
  assert.equal(mismatch?.expectedSha256, sha);
  assert.match(mismatch?.actualSha256 ?? "", /^[a-f0-9]{64}$/);
  const missing = issues.find((issue) => issue.reason === "missing");
  assert.equal(missing?.phase, "P0");
  assert.equal(missing?.path, "data/ghost.jsonl");
  assert.equal(missing?.expectedSha256, "b".repeat(64));
  assert.equal(missing?.actualSha256, undefined);
});

test("verifyLedgerArtifacts ignores phases that are not done and empty hash maps", async () => {
  const root = await mkdtemp(join("/tmp", "artifact-verify-pending-"));
  const ledger = createInitialLedger({ mode: "dry-run" });
  assert.deepEqual(await verifyLedgerArtifacts(root, ledger), []);
  let working = markPhaseWorking(ledger, "P0");
  working = markPhaseDone(working, "P0", { artifacts: [], artifactHashes: {} });
  assert.deepEqual(await verifyLedgerArtifacts(root, working), []);
});

test("recordArtifact replaces stale entries for the same file path", async () => {
  const root = await mkdtemp(join("/tmp", "artifact-record-replace-"));
  const file = join(root, "sample.jsonl");
  await writeFile(file, "v1\n", "utf8");
  let manifest = createArtifactManifest("dry-run");
  manifest = await recordArtifact(manifest, file, { phase: "P2.0", storage: "local", relativePath: "data/sample.jsonl" });
  await writeFile(file, "v2 with much longer content\n", "utf8");
  manifest = await recordArtifact(manifest, file, { phase: "P2.0", storage: "local", relativePath: "data/sample.jsonl" });
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].path, "data/sample.jsonl");
  assert.equal(manifest.artifacts[0].sha256, createHash("sha256").update("v2 with much longer content\n").digest("hex"));
});
