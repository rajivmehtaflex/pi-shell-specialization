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
