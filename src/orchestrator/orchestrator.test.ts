import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInitialLedger } from "./phase-ledger.ts";
import { InMemoryRemoteExecutor, type RemoteExecutor, type RemoteJob } from "./remote-executor.ts";
import { PhaseOrchestrator, type PhaseHandler } from "./orchestrator.ts";
import { createCommandHandlers } from "./runtime-config.ts";
import type { PhaseLedger } from "./phase-types.ts";

const VALID_SHA = "a".repeat(64);

function staticRemote(status: RemoteJob["status"], extra: Partial<RemoteJob> = {}): RemoteExecutor & { polls: () => number } {
  let polls = 0;
  return {
    simulationSafe: false,
    async launch() { throw new Error("not used"); },
    async status(jobId) {
      polls += 1;
      return { id: jobId, phase: "P0", status, estimatedCostUsd: 0, artifacts: [], simulation: false, ...extra };
    },
    async cancel() {},
    async logs() { return ""; },
    polls: () => polls,
  };
}

async function writeManifest(root: string, phaseId: string, manifest: unknown): Promise<string> {
  const target = join(root, "state", "runs", phaseId, "result.json");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(manifest), "utf8");
  return target;
}

function interruptedLedger(): PhaseLedger {
  const ledger = createInitialLedger({ mode: "live" });
  const phase = ledger.phases[0];
  phase.status = "interrupted";
  phase.jobId = "ssh-P0-abc123";
  phase.error = "previous orchestrator stopped; remote job requires status polling";
  phase.estimatedGpuSeconds = 100;
  return ledger;
}

test("orchestrator enforces dependencies and checkpoints a completed phase", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-test-"));
  const checkpoints: string[] = [];
  const handler: PhaseHandler = {
    async run({ phase }) {
      return { status: "done", artifacts: [`artifacts/${phase.id}.json`], artifactHashes: { [`artifacts/${phase.id}.json`]: "hash" }, nextAction: "next" };
    },
  };
  const orchestrator = new PhaseOrchestrator({
    root,
    mode: "dry-run",
    handlers: new Map([["P0", handler]]),
    checkpoint: async (label) => { checkpoints.push(label); return `dry-run-${label}`; },
    now: () => "2026-08-19T00:00:00Z",
  });
  const blocked = await orchestrator.runPhase("P2.0");
  assert.equal(blocked.kind, "blocked");
  const result = await orchestrator.runPhase("P0");
  assert.equal(result.kind, "done");
  assert.deepEqual(checkpoints, ["before-launch", "complete"]);
  assert.equal(result.ledger.phases.find((phase) => phase.id === "P0")?.status, "done");
});

test("orchestrator persists a remote job and leaves phase working", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-job-"));
  const remote = new InMemoryRemoteExecutor();
  const handler: PhaseHandler = {
    async run() {
      const job = await remote.launch({ phase: "P0", command: "sleep 1", gpu: "L4", timeoutSeconds: 10, estimatedCostUsd: 0, simulation: false });
      return { status: "working", job, nextAction: "poll remote job" };
    },
  };
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map([["P0", handler]]), remote, checkpoint: async () => "commit-1" });
  const result = await orchestrator.runPhase("P0");
  assert.equal(result.kind, "working");
  assert.equal(result.ledger.phases[0].status, "working");
  assert.match(result.ledger.phases[0].jobId ?? "", /^remote-/);
});

test("orchestrator resumes stale phases without rerunning completed phases", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-resume-"));
  const remote: RemoteExecutor = {
    simulationSafe: false,
    async launch() { throw new Error("not used"); },
    async status(jobId) { return { id: jobId, phase: "P0", status: "running", estimatedCostUsd: 0, artifacts: [], simulation: false }; },
    async cancel() {},
    async logs() { return "running"; },
  };
  const ledger = createInitialLedger({ mode: "live" });
  ledger.phases[0].status = "working";
  ledger.phases[0].jobId = "ssh-P0-abc";
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", remote, initialLedger: ledger, handlers: new Map(), checkpoint: async () => undefined });
  const resumed = await orchestrator.resume();
  assert.equal(resumed.phases[0].status, "working");
  assert.equal(resumed.phases[0].nextAction, "poll remote job");
});

test("runPhase reconciles a working phase with a registered job instead of relaunching", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-guard-"));
  let launches = 0;
  const remote = new InMemoryRemoteExecutor();
  const handler: PhaseHandler = {
    async run() {
      launches += 1;
      const job = await remote.launch({ phase: "P0", command: "sleep 1", gpu: "1xL4", timeoutSeconds: 10, estimatedCostUsd: 0, simulation: false });
      return { status: "working", job, nextAction: "poll remote job" };
    },
  };
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map([["P0", handler]]), remote, checkpoint: async () => undefined });
  const first = await orchestrator.runPhase("P0");
  assert.equal(first.kind, "working");
  assert.equal(first.ledger.phases[0].jobId, "remote-1");
  const second = await orchestrator.runPhase("P0");
  assert.equal(second.kind, "working");
  assert.equal(second.ledger.phases[0].jobId, "remote-1");
  assert.equal(launches, 1);
  const after = await orchestrator.status();
  assert.equal(after.phases[0].jobId, "remote-1");
  assert.equal(launches, 1);
});

test("runPhase refuses a working phase when no remote executor can reconcile it", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-guard-live-"));
  const ledger = createInitialLedger({ mode: "live" });
  ledger.phases[0].status = "working";
  ledger.phases[0].jobId = "ssh-P0-abc123";
  let launches = 0;
  const handler: PhaseHandler = {
    async run() {
      launches += 1;
      return { status: "working" };
    },
  };
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map([["P0", handler]]), initialLedger: ledger, checkpoint: async () => undefined });
  await assert.rejects(() => orchestrator.runPhase("P0"), /already working \(job ssh-P0-abc123\); resume or cancel/);
  assert.equal(launches, 0);
});

test("failed phases require explicit retryPhase and runNext never auto-retries", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-retry-"));
  let launches = 0;
  const handler: PhaseHandler = {
    async run({ phase }) {
      launches += 1;
      if (launches === 1) throw new Error("boom");
      return { status: "done", artifacts: [`artifacts/${phase.id}.json`], artifactHashes: { [`artifacts/${phase.id}.json`]: "hash" }, nextAction: "next" };
    },
  };
  const orchestrator = new PhaseOrchestrator({ root, mode: "dry-run", handlers: new Map([["P0", handler]]), checkpoint: async () => undefined });
  const failed = await orchestrator.runPhase("P0");
  assert.equal(failed.kind, "failed");
  assert.equal(failed.ledger.phases[0].status, "failed");
  assert.equal(failed.error, "boom");
  await assert.rejects(() => orchestrator.runPhase("P0"), /retryPhase\("P0"\)/);
  const next = await orchestrator.runNext();
  assert.equal(next.kind, "blocked");
  assert.match(next.kind === "blocked" ? next.reason : "", /blocked by: P0/);
  assert.equal(launches, 1);
  assert.equal(next.ledger.phases.find((phase) => phase.id === "P0")?.status, "failed");
  await assert.rejects(() => orchestrator.retryPhase("P2.0"), /not failed/);
  const retried = await orchestrator.retryPhase("P0");
  assert.equal(retried.kind, "done");
  assert.equal(launches, 2);
  const phase = retried.ledger.phases.find((candidate) => candidate.id === "P0");
  assert.equal(phase?.status, "done");
  assert.equal(phase?.error, undefined);
});

test("runNext skips done phases and never relaunches them", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-done-"));
  let launches = 0;
  const handler: PhaseHandler = {
    async run({ phase }) {
      launches += 1;
      return { status: "done", artifacts: [`artifacts/${phase.id}.json`], artifactHashes: {}, nextAction: "next" };
    },
  };
  const orchestrator = new PhaseOrchestrator({ root, mode: "dry-run", handlers: new Map([["P0", handler]]), checkpoint: async () => undefined });
  await orchestrator.runPhase("P0");
  const next = await orchestrator.runNext();
  assert.equal(next.kind, "blocked");
  assert.match(next.kind === "blocked" ? next.reason : "", /no phase handler registered for P2\.0/);
  assert.equal(launches, 1);
});

test("runNext relaunches interrupted phases that have no live remote job", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-interrupted-"));
  let launches = 0;
  const handler: PhaseHandler = {
    async run() {
      launches += 1;
      return { status: "working", nextAction: "poll phase status" };
    },
  };
  const ledger = createInitialLedger({ mode: "live" });
  ledger.phases[0].status = "interrupted";
  ledger.phases[0].error = "previous orchestrator stopped before a remote job was registered";
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map([["P0", handler]]), initialLedger: ledger, checkpoint: async () => undefined });
  const next = await orchestrator.runNext();
  assert.equal(next.kind, "working");
  assert.equal(launches, 1);
  assert.equal(next.ledger.phases[0].status, "working");
});

test("reconcilePhase completes a finished job only with a valid result manifest", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-manifest-"));
  const remote = staticRemote("done", { exitCode: 0, finishedAt: "2026-09-06T09:30:00Z", gpuSeconds: 40, actualCostUsd: 0.5 });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async (label) => label });
  const missing = await orchestrator.reconcilePhase("P0");
  assert.equal(missing.kind, "interrupted");
  const pendingPhase = missing.ledger.phases[0];
  assert.notEqual(pendingPhase.status, "done");
  assert.match(pendingPhase.nextAction ?? "", /result manifest/i);
  assert.match(pendingPhase.error ?? "", /result\.json/);

  await writeManifest(root, "P0", {
    phase: "P0",
    status: "success",
    artifacts: [{ path: "artifacts/weakness_profile.json", sha256: VALID_SHA }],
    completedAt: "2026-09-06T09:30:00Z",
  });
  const done = await orchestrator.reconcilePhase("P0");
  assert.equal(done.kind, "done");
  const phase = done.ledger.phases[0];
  assert.equal(phase.status, "done");
  assert.deepEqual(phase.artifacts, ["artifacts/weakness_profile.json"]);
  assert.equal(phase.artifactHashes["artifacts/weakness_profile.json"], VALID_SHA);
  assert.equal(phase.completedAt, "2026-09-06T09:30:00Z");
  assert.equal(phase.gpuSeconds, 40);
  assert.equal(phase.actualCostUsd, 0.5);
});

test("reconcilePhase refuses done jobs whose manifest has a bad sha256 or wrong phase", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-badmanifest-"));
  const remote = staticRemote("done", { exitCode: 0 });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async () => undefined });
  await writeManifest(root, "P0", {
    phase: "P0",
    status: "success",
    artifacts: [{ path: "artifacts/p0.json", sha256: "not-a-hash" }],
    completedAt: "2026-09-06T09:30:00Z",
  });
  const badSha = await orchestrator.reconcilePhase("P0");
  assert.equal(badSha.kind, "interrupted");
  assert.notEqual(badSha.ledger.phases[0].status, "done");

  await writeManifest(root, "P0", {
    phase: "P2.6",
    status: "success",
    artifacts: [{ path: "artifacts/p0.json", sha256: VALID_SHA }],
    completedAt: "2026-09-06T09:30:00Z",
  });
  const wrongPhase = await orchestrator.reconcilePhase("P0");
  assert.equal(wrongPhase.kind, "interrupted");
  assert.match(wrongPhase.ledger.phases[0].error ?? "", /phase mismatch/);
});

test("reconcilePhase marks the phase failed when the manifest reports failure", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-manifest-fail-"));
  const remote = staticRemote("done", { exitCode: 0 });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async () => undefined });
  await writeManifest(root, "P0", {
    phase: "P0",
    status: "failed",
    artifacts: [],
    completedAt: "2026-09-06T09:30:00Z",
    error: "weakness profile validation failed",
  });
  const result = await orchestrator.reconcilePhase("P0");
  assert.equal(result.kind, "failed");
  assert.equal(result.error, "weakness profile validation failed");
  assert.equal(result.ledger.phases[0].status, "failed");
});

test("reconcilePhase maps unknown remote status to interrupted, never done or failed", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-unknown-"));
  const remote = staticRemote("unknown", { exitCode: null, error: "SSH status probe failed (exit 255): connection refused" });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async () => undefined });
  const result = await orchestrator.reconcilePhase("P0");
  assert.equal(result.kind, "interrupted");
  const phase = result.ledger.phases[0];
  assert.equal(phase.status, "interrupted");
  assert.match(phase.error ?? "", /connection refused/);
});

test("reconcilePhase maps failed remote jobs to failed phases with the exit code", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-remotefail-"));
  const remote = staticRemote("failed", { exitCode: 3, error: "remote job exited with code 3; inspect /workspace/state/ssh-jobs/ssh-P0-abc123.log" });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async () => undefined });
  const result = await orchestrator.reconcilePhase("P0");
  assert.equal(result.kind, "failed");
  const phase = result.ledger.phases[0];
  assert.equal(phase.status, "failed");
  assert.match(phase.error ?? "", /exit 3/);
  await assert.rejects(() => orchestrator.reconcilePhase("P2.1"), /no registered remote job/);
});

test("resume() reconciles interrupted phases end-to-end through saved jobs", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-resume-manifest-"));
  const remote = staticRemote("done", { exitCode: 0, finishedAt: "2026-09-06T09:30:00Z" });
  await writeManifest(root, "P0", {
    phase: "P0",
    status: "success",
    artifacts: [{ path: "artifacts/weakness_profile.json", sha256: VALID_SHA }],
    completedAt: "2026-09-06T09:30:00Z",
  });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async () => undefined });
  const resumed = await orchestrator.resume();
  const phase = resumed.phases[0];
  assert.equal(phase.status, "done");
  assert.deepEqual(phase.artifacts, ["artifacts/weakness_profile.json"]);
  assert.equal(remote.polls(), 1);
  await assert.rejects(() => orchestrator.reconcilePhase("P2.1"), /no registered remote job/);
});

test("reconciliation fails a phase whose GPU usage exceeds twice the estimate", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-budget-"));
  const remote = staticRemote("done", { exitCode: 0, gpuSeconds: 300, actualCostUsd: 9 });
  const orchestrator = new PhaseOrchestrator({ root, mode: "live", handlers: new Map(), remote, initialLedger: interruptedLedger(), checkpoint: async () => undefined });
  const result = await orchestrator.reconcilePhase("P0");
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /GPU usage 300s exceeded 2x budget 200s/);
  assert.equal(result.ledger.phases[0].status, "failed");
  assert.notEqual(result.ledger.phases[0].status, "done");
});

test("dry-run orchestrator fails phases whose handlers target live executors", async () => {
  const root = await mkdtemp(join("/tmp", "shell-orchestrator-dryrun-live-"));
  const liveExecutor = staticRemote("running");
  let launches = 0;
  const handlers = createCommandHandlers(new Map([["P0", { command: "bash workers/p0.sh", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 }]]), {
    simulationSafe: false,
    async launch() {
      launches += 1;
      throw new Error("live executor must not be called");
    },
    async status() { throw new Error("not used"); },
    async cancel() {},
    async logs() { return ""; },
  });
  const orchestrator = new PhaseOrchestrator({ root, mode: "dry-run", handlers, remote: liveExecutor, checkpoint: async () => undefined });
  const result = await orchestrator.runPhase("P0");
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /dry-run mode cannot launch live jobs/);
  assert.equal(launches, 0);
});
