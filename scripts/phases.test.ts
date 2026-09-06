/**
 * Phase-script contract tests (Wave-3, T8.2).
 *
 * The bash phase scripts under scripts/phases/ must:
 *   1. be syntax-clean (`bash -n`);
 *   2. emit result manifests at state/runs/<phaseId>/result.json that satisfy
 *      the same contract src/orchestrator/phase-ledger.ts enforces
 *      (parsePhaseResultManifest): phase id, "success"|"failed", non-empty
 *      artifacts with plausible 64-hex sha256 for success, completedAt;
 *   3. compute REAL sha256 digests (the orchestrator recomputes them on
 *      resume; a fake hash marks the phase failed);
 *   4. refuse external prerequisites with a clear failed manifest and a
 *      nonzero exit (never guess or silently continue);
 *   5. hard-refuse single-GPU configurations for P2.6 AsyncGRPO.
 *
 * All scripts run against a sandbox directory via PHASE_PROJECT_ROOT, so the
 * repository's own state/, data/, and artifacts/ directories are never
 * touched. No test performs network access, GPU work, or pushes.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PHASES_DIR = fileURLToPath(new URL("./phases", import.meta.url));

/** Phase ids exactly as declared in src/orchestrator/phase-types.ts. */
const PHASE_SCRIPTS: Record<string, string> = {
  "P0": "p0-baseline.sh",
  "P2.0": "p2-0-data-foundation.sh",
  "P2.1": "p2-1-teacher-inference.sh",
  "P2.2": "p2-2-audit-split.sh",
  "P2.3": "p2-3-sft.sh",
  "P2.4": "p2-4-merge-upload.sh",
  "P2.5": "p2-5-eval.sh",
  "P2.6": "p2-6-async-grpo.sh",
  "P2.6b": "p2-6b-merge-upload.sh",
  "P2.7": "p2-7-serve.sh",
  "P2.8": "p2-8-export.sh",
};

/** Phases whose local-verifiable part must succeed in a clean sandbox. */
const LOCAL_SUCCESS = new Set(["P0", "P2.0", "P2.8"]);
/** Phases that must fail with a prerequisite error when inputs are absent. */
const PREREQUISITE_PHASES = new Set(["P2.1", "P2.2", "P2.3", "P2.4", "P2.5", "P2.6", "P2.6b", "P2.7"]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runBash(args: string[], env: NodeJS.ProcessEnv): RunResult {
  const result = spawnSync("bash", args, { env, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Strips every prerequisite-carrying variable so tests start from a clean slate. */
function sandboxEnv(projectRoot: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(PI|GRPO|TRAIN|EVAL|SERVE|MERGE|SFT|TEACHER|HF)_/.test(key)) continue;
    env[key] = value;
  }
  env.PHASE_PROJECT_ROOT = projectRoot;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "phase-scripts-test-"));
}

function manifestPath(sandbox: string, phaseId: string): string {
  return join(sandbox, "state", "runs", phaseId, "result.json");
}

function readManifest(sandbox: string, phaseId: string): any {
  return JSON.parse(readFileSync(manifestPath(sandbox, phaseId), "utf8"));
}

/** Minimal re-implementation of parsePhaseResultManifest's shape checks. */
function assertValidManifest(manifest: any, expectedPhase: string): void {
  assert.equal(manifest.phase, expectedPhase);
  assert.ok(manifest.status === "success" || manifest.status === "failed", `bad status: ${manifest.status}`);
  assert.ok(!Number.isNaN(Date.parse(manifest.completedAt)), `bad completedAt: ${manifest.completedAt}`);
  assert.ok(typeof manifest.error === "undefined" || typeof manifest.error === "string");
  if (manifest.status === "success") {
    assert.ok(Array.isArray(manifest.artifacts) && manifest.artifacts.length >= 1, "success manifests need at least one artifact");
  }
  for (const artifact of manifest.artifacts ?? []) {
    assert.equal(typeof artifact.path, "string");
    assert.match(artifact.path, /^(state|data|artifacts|runs)\//);
    assert.match(artifact.sha256, SHA256_PATTERN);
  }
}

function assertArtifactsAreReallyHashed(sandbox: string, manifest: any): void {
  for (const artifact of manifest.artifacts) {
    const digest = createHash("sha256").update(readFileSync(join(sandbox, artifact.path))).digest("hex");
    assert.equal(artifact.sha256, digest, `manifest digest for ${artifact.path} is not the real sha256`);
  }
}

test("every scripts/phases/*.sh script passes bash -n", () => {
  const files = readdirSync(PHASES_DIR).filter((file) => file.endsWith(".sh")).sort();
  assert.ok(files.includes("lib.sh"), "lib.sh must exist");
  assert.ok(files.includes("p0-baseline.sh") && files.includes("p2-6-async-grpo.sh"), "docs example script names must keep working");
  for (const file of files) {
    const result = runBash(["-n", join(PHASES_DIR, file)], process.env);
    assert.equal(result.status, 0, `bash -n failed for ${file}: ${result.stderr}`);
  }
});

test("lib.sh manifest helpers emit a valid success manifest with real sha256 digests", () => {
  const sandbox = makeSandbox();
  const driver = [
    "set -euo pipefail",
    `source "${join(PHASES_DIR, "lib.sh")}"`,
    'manifest_begin "P0"',
    'mkdir -p "$PROJECT_ROOT/artifacts/smoke"',
    'printf \'payload\\n\' > "$PROJECT_ROOT/artifacts/smoke/payload.txt"',
    'manifest_add_artifact "$PROJECT_ROOT/artifacts/smoke/payload.txt"',
    'manifest_emit_success',
  ].join("\n");
  const result = runBash(["-c", driver], sandboxEnv(sandbox));
  assert.equal(result.status, 0, result.stderr);
  const manifest = readManifest(sandbox, "P0");
  assertValidManifest(manifest, "P0");
  assert.equal(manifest.status, "success");
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].path, "artifacts/smoke/payload.txt");
  assert.equal(manifest.error, undefined);
  assertArtifactsAreReallyHashed(sandbox, manifest);
});

test("lib.sh refuses a success manifest with zero artifacts", () => {
  const sandbox = makeSandbox();
  const driver = [
    "set -euo pipefail",
    `source "${join(PHASES_DIR, "lib.sh")}"`,
    'manifest_begin "P2.0"',
    'manifest_emit_success',
  ].join("\n");
  const result = runBash(["-c", driver], sandboxEnv(sandbox));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least one artifact/);
  assert.equal(existsSync(manifestPath(sandbox, "P2.0")), false, "no manifest may be written for an artifact-less success");
});

test("lib.sh phase_fail emits a failed manifest and exits nonzero", () => {
  const sandbox = makeSandbox();
  const driver = [
    "set -euo pipefail",
    `source "${join(PHASES_DIR, "lib.sh")}"`,
    'manifest_begin "P2.1"',
    'phase_fail "external prerequisite missing: boom"',
  ].join("\n");
  const result = runBash(["-c", driver], sandboxEnv(sandbox));
  assert.equal(result.status, 1);
  const manifest = readManifest(sandbox, "P2.1");
  assertValidManifest(manifest, "P2.1");
  assert.equal(manifest.status, "failed");
  assert.match(manifest.error, /external prerequisite missing: boom/);
});

test("lib.sh rejects artifacts outside the committable roots", () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox, "outside.txt"), "x\n");
  const driver = [
    "set -euo pipefail",
    `source "${join(PHASES_DIR, "lib.sh")}"`,
    'manifest_begin "P2.0"',
    'manifest_add_artifact "$PROJECT_ROOT/outside.txt"',
  ].join("\n");
  const result = runBash(["-c", driver], sandboxEnv(sandbox));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /COMMITTABLE_ROOTS/);
});

test("the P2.6 two-GPU gate refuses single-GPU and misconfigured environments", () => {
  const cases: Array<{ env: Record<string, string>; expectPass: boolean; errorPattern?: RegExp }> = [
    { env: {}, expectPass: false, errorPattern: /GRPO_GPUS must list at least two distinct GPU ids/ },
    { env: { GRPO_GPUS: "0" }, expectPass: false, errorPattern: /never runs single-GPU/ },
    { env: { GRPO_GPUS: "1,1" }, expectPass: false, errorPattern: /never runs single-GPU/ },
    { env: { GRPO_GPUS: "0,1", PI_GRPO_REQUIRE_2_GPU: "0" }, expectPass: false, errorPattern: /PI_GRPO_REQUIRE_2_GPU must be '1' or unset/ },
    { env: { GRPO_GPUS: "0,1" }, expectPass: true },
    { env: { GRPO_GPUS: "0 1" }, expectPass: true },
    { env: { GRPO_GPUS: "cuda:0,cuda:1" }, expectPass: true },
  ];
  for (const item of cases) {
    const sandbox = makeSandbox();
    const driver = [
      "set -euo pipefail",
      `source "${join(PHASES_DIR, "lib.sh")}"`,
      'manifest_begin "P2.6"',
      "require_two_gpus",
      'echo gate-passed',
    ].join("\n");
    const result = runBash(["-c", driver], sandboxEnv(sandbox, item.env));
    assert.equal(result.status, item.expectPass ? 0 : 1, `env ${JSON.stringify(item.env)}: ${result.stderr}`);
    if (item.expectPass) {
      assert.match(result.stdout, /gate-passed/);
    } else {
      const manifest = readManifest(sandbox, "P2.6");
      assert.equal(manifest.status, "failed");
      assert.match(manifest.error, item.errorPattern!);
    }
  }
});

test("p2-6-async-grpo.sh still refuses to run with two GPUs but no trainer command", () => {
  const sandbox = makeSandbox();
  const result = runBash([join(PHASES_DIR, "p2-6-async-grpo.sh")], sandboxEnv(sandbox, { GRPO_GPUS: "0,1" }));
  assert.equal(result.status, 1);
  const manifest = readManifest(sandbox, "P2.6");
  assert.equal(manifest.status, "failed");
  assert.match(manifest.error, /GRPO_COMMAND/);
});

for (const [phaseId, script] of Object.entries(PHASE_SCRIPTS)) {
  test(`phase ${phaseId} emits a valid result manifest (${script})`, () => {
    const sandbox = makeSandbox();
    const result = runBash([join(PHASES_DIR, script)], sandboxEnv(sandbox));
    assert.ok(existsSync(manifestPath(sandbox, phaseId)), `manifest missing for ${phaseId}: ${result.stderr}`);
    const manifest = readManifest(sandbox, phaseId);
    assertValidManifest(manifest, phaseId);
    if (LOCAL_SUCCESS.has(phaseId)) {
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.equal(manifest.status, "success");
      assertArtifactsAreReallyHashed(sandbox, manifest);
    } else {
      assert.equal(result.status, 1, `stdout: ${result.stdout}`);
      assert.equal(manifest.status, "failed");
      if (PREREQUISITE_PHASES.has(phaseId)) {
        assert.match(manifest.error ?? "", /prerequisite missing/i);
      }
    }
  });
}

function syntheticTeacherRows(count: number): string {
  const lines: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `smoke-${String(index).padStart(4, "0")}`;
    const prompt = `Print the token ${id} exactly once.`;
    const response = "```bash\n" + `echo ${id}\n` + "```";
    lines.push(JSON.stringify({
      task_id: id,
      task: { id, prompt, category: `cat-${index % 4}` },
      response,
      verification: "passed",
      execution: { status: "passed", exitCode: 0, stdout: `${id}\n`, stderr: "", durationMs: 12, findings: [] },
      checks: [{ type: "stdout_contains", value: id }],
      content_hash: createHash("sha256").update(`${prompt}:${response}`).digest("hex"),
    }));
  }
  return lines.join("\n") + "\n";
}

test("p2-2-audit-split smoke: 2400 synthetic rows pass the production dataset gate", () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox, "state"), { recursive: true });
  writeFileSync(join(sandbox, "state", "teacher_raw.jsonl"), syntheticTeacherRows(2400));
  const startedAt = Date.now();
  const result = runBash([join(PHASES_DIR, "p2-2-audit-split.sh")], sandboxEnv(sandbox));
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.ok(elapsedMs < 15000, `smoke must stay fast, took ${elapsedMs}ms`);
  const gate = JSON.parse(readFileSync(join(sandbox, "artifacts", "dataset-gate.json"), "utf8"));
  assert.equal(gate.mode, "live");
  assert.equal(gate.passed, true);
  assert.equal(gate.productionReady, true);
  assert.equal(gate.train, 1900);
  assert.equal(gate.eval, 250);
  assert.equal(gate.holdout, 250);
  assert.ok(gate.balanceDelta <= 0.1, `balanceDelta ${gate.balanceDelta} exceeds 0.1`);
  const manifest = readManifest(sandbox, "P2.2");
  assert.equal(manifest.status, "success");
  assertArtifactsAreReallyHashed(sandbox, manifest);
});

test("p2-2-audit-split refuses an undersized dataset in live mode", () => {
  const sandbox = makeSandbox();
  mkdirSync(join(sandbox, "state"), { recursive: true });
  writeFileSync(join(sandbox, "state", "teacher_raw.jsonl"), syntheticTeacherRows(50));
  const result = runBash([join(PHASES_DIR, "p2-2-audit-split.sh")], sandboxEnv(sandbox));
  assert.equal(result.status, 1);
  const manifest = readManifest(sandbox, "P2.2");
  assert.equal(manifest.status, "failed");
  assert.match(manifest.error, /split\.py failed/);
});
