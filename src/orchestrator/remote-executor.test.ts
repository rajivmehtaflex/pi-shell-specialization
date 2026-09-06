import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRemoteExecutor, type RemoteJob } from "./remote-executor.ts";

test("RemoteJob carries outcome metadata for reconciliation and runPhase guards", () => {
  const job: RemoteJob = {
    id: "ssh-P2.3-x9",
    phase: "P2.3",
    status: "unknown",
    estimatedCostUsd: 0,
    artifacts: [],
    exitCode: null,
    error: "no exit marker and no live pid for ssh-P2.3-x9",
    finishedAt: "2026-09-06T10:00:00Z",
    resultPath: "/workspace/state/ssh-jobs/ssh-P2.3-x9/result.json",
    verifiedArtifacts: [{ path: "/workspace/artifacts/adapter.safetensors", sha256: "abc123" }],
  };
  assert.equal(job.status, "unknown");
  assert.equal(job.exitCode, null);
  assert.equal(job.finishedAt, "2026-09-06T10:00:00Z");
  assert.equal(job.verifiedArtifacts?.[0].path, "/workspace/artifacts/adapter.safetensors");
  assert.equal(job.verifiedArtifacts?.[0].sha256, "abc123");
});

test("in-memory executor keeps its launch/status/cancel lifecycle with the extended status union", async () => {
  const executor = new InMemoryRemoteExecutor();
  assert.equal(executor.simulationSafe, true);
  const live = await executor.launch({ phase: "P2.1", command: "real work", gpu: "1xL4", timeoutSeconds: 10, estimatedCostUsd: 2 });
  assert.equal(live.status, "queued");
  const simulated = await executor.launch({ phase: "P2.0", command: "dry", gpu: "none", timeoutSeconds: 1, estimatedCostUsd: 0, simulation: true });
  assert.equal((await executor.status(simulated.id)).status, "done");
  await executor.cancel(live.id);
  assert.equal((await executor.status(live.id)).status, "cancelled");
  await assert.rejects(() => executor.status("remote-999"), /unknown remote job/);
});
