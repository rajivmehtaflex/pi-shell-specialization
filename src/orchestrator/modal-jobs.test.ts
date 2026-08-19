import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryRemoteExecutor } from "./remote-executor.ts";
import { enforceGpuBudget, makeJobSpec } from "./modal-jobs.ts";

test("job spec records phase, GPU, timeout, and estimated cost", () => {
  const spec = makeJobSpec({ phase: "P2.3", command: "python workers/train/sft.py", gpu: "L4", timeoutSeconds: 3600, estimatedCostUsd: 4 });
  assert.equal(spec.phase, "P2.3");
  assert.equal(spec.gpu, "L4");
  assert.equal(spec.estimatedCostUsd, 4);
});

test("GPU cost guard allows under-budget jobs and blocks overrun", () => {
  assert.doesNotThrow(() => enforceGpuBudget({ gpuSeconds: 100, estimatedGpuSeconds: 100 }));
  assert.throws(() => enforceGpuBudget({ gpuSeconds: 201, estimatedGpuSeconds: 100 }), /2x|overrun|budget/i);
});

test("in-memory remote executor supports launch/status/cancel without network", async () => {
  const executor = new InMemoryRemoteExecutor();
  const job = await executor.launch({ phase: "P2.3", command: "dry-run", gpu: "L4", timeoutSeconds: 1, estimatedCostUsd: 0, simulation: true });
  assert.equal((await executor.status(job.id)).status, "done");
  await executor.cancel(job.id);
  assert.equal((await executor.status(job.id)).status, "cancelled");
  assert.match(await executor.logs(job.id), /simulation|P2.3/i);
});
