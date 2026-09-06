import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createInitialLedger } from "./phase-ledger.ts";
import { InMemoryRemoteExecutor, type RemoteExecutor } from "./remote-executor.ts";
import { PhaseOrchestrator, type PhaseHandler } from "./orchestrator.ts";
import type { PhaseLedger } from "./phase-types.ts";

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

test("runPhase never relaunches a phase that is already working", async () => {
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
  await assert.rejects(() => orchestrator.runPhase("P0"), /already working \(job remote-1\); resume or cancel/);
  assert.equal(launches, 1);
  const after = await orchestrator.status();
  assert.equal(after.phases[0].jobId, "remote-1");
  assert.equal(launches, 1);
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
