import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRemoteExecutor, type RemoteJob } from "./remote-executor.ts";
import { enforceGpuBudget, enforceJobCost, makeJobSpec } from "./modal-jobs.ts";

function jobWithGpuSeconds(gpuSeconds?: number): RemoteJob {
  return { id: "ssh-P2.3-abc", phase: "P2.3", status: "done", gpuSeconds, estimatedCostUsd: 4, artifacts: [], simulation: false };
}

test("job spec records phase, GPU, timeout, and estimated cost", () => {
  const spec = makeJobSpec({ phase: "P2.3", command: "python workers/train/sft.py", gpu: "1xL4", timeoutSeconds: 3600, estimatedCostUsd: 4 });
  assert.equal(spec.phase, "P2.3");
  assert.equal(spec.gpu, "1xL4");
  assert.equal(spec.estimatedCostUsd, 4);
  assert.throws(() => makeJobSpec({ phase: "", command: "x", gpu: "1xL4", timeoutSeconds: 1, estimatedCostUsd: 0 }), /invalid remote job spec/);
  assert.throws(() => makeJobSpec({ phase: "P2.3", command: "x", gpu: "1xL4", timeoutSeconds: 0, estimatedCostUsd: 0 }), /invalid remote job spec/);
});

test("GPU cost guard allows under-budget jobs and blocks overrun", () => {
  assert.doesNotThrow(() => enforceGpuBudget({ gpuSeconds: 100, estimatedGpuSeconds: 100 }));
  assert.throws(() => enforceGpuBudget({ gpuSeconds: 201, estimatedGpuSeconds: 100 }), /2x|overrun|budget/i);
});

test("enforceJobCost guards a finished job's gpuSeconds against twice the estimate", () => {
  assert.doesNotThrow(() => enforceJobCost(jobWithGpuSeconds(200), 100));
  assert.doesNotThrow(() => enforceJobCost(jobWithGpuSeconds(undefined), 100));
  assert.throws(() => enforceJobCost(jobWithGpuSeconds(201), 100), /budget/i);
});

test("in-memory remote executor supports launch/status/cancel without network", async () => {
  const executor = new InMemoryRemoteExecutor();
  const job = await executor.launch({ phase: "P2.3", command: "dry-run", gpu: "L4", timeoutSeconds: 1, estimatedCostUsd: 0, simulation: true });
  assert.equal((await executor.status(job.id)).status, "done");
  await executor.cancel(job.id);
  assert.equal((await executor.status(job.id)).status, "cancelled");
  assert.match(await executor.logs(job.id), /simulation|P2.3/i);
});
