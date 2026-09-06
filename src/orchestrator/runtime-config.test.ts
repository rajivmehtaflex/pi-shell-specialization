import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandHandlers, loadPhaseCommands, createConfiguredSshExecutor } from "./runtime-config.ts";
import type { PhaseHandler } from "./orchestrator.ts";
import type { PhaseLedger } from "./phase-types.ts";
import type { JobSpec, RemoteExecutor, RemoteJob } from "./remote-executor.ts";

function fakeExecutor(options: { simulationSafe: boolean; onLaunch?: (spec: JobSpec) => RemoteJob }): RemoteExecutor & { launches: JobSpec[] } {
  const launches: JobSpec[] = [];
  return {
    simulationSafe: options.simulationSafe,
    launches,
    async launch(spec) {
      launches.push(spec);
      return options.onLaunch?.(spec) ?? { id: "ssh-P0-test", phase: spec.phase, status: "running", estimatedCostUsd: 0, artifacts: [], simulation: spec.simulation ?? false };
    },
    async status() { throw new Error("not used"); },
    async cancel() {},
    async logs() { return ""; },
  };
}

function handlerContext(mode: "dry-run" | "live"): Parameters<PhaseHandler["run"]>[0] {
  return {
    root: "/tmp/project",
    mode,
    ledger: {} as PhaseLedger,
    phase: { id: "P0", name: "P0", status: "working", executionMode: mode, attempt: 1, computeMode: "single-gpu", requiredGpuCount: 1, artifacts: [], artifactHashes: {} },
  };
}

async function writeCommandsFile(root: string, commands: Record<string, unknown>): Promise<void> {
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  await writeFile(join(state, "phase-commands.json"), JSON.stringify(commands), "utf8");
}

test("phase command config loads non-secret SSH phase commands", async () => {
  const root = await mkdtemp(join("/tmp", "shell-runtime-config-"));
  await writeCommandsFile(root, { P0: { command: "bash workers/p0.sh", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 } });
  const commands = loadPhaseCommands(root);
  assert.equal(commands.get("P0")?.command, "bash workers/p0.sh");
  assert.equal(commands.get("P0")?.gpu, "1xL4");
});

test("configured phase handlers launch jobs through the injected SSH executor", async () => {
  const executor = fakeExecutor({ simulationSafe: false });
  const handlers = createCommandHandlers(new Map([["P0", { command: "bash workers/p0.sh", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 }]]), executor);
  const result = await handlers.get("P0")!.run(handlerContext("live"));
  assert.equal(result.status, "working");
  assert.equal(executor.launches[0].command, "bash workers/p0.sh");
  assert.equal(executor.launches[0].simulation, false);
  assert.equal(result.job?.id, "ssh-P0-test");
});

test("dry-run handlers refuse live executors before any launch call", async () => {
  const executor = fakeExecutor({ simulationSafe: false });
  const handlers = createCommandHandlers(new Map([["P0", { command: "bash workers/p0.sh", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 }]]), executor);
  await assert.rejects(() => handlers.get("P0")!.run(handlerContext("dry-run")), /dry-run mode cannot launch live jobs/);
  assert.equal(executor.launches.length, 0);
});

test("dry-run handlers launch simulation specs through simulation-safe executors", async () => {
  const executor = fakeExecutor({ simulationSafe: true });
  const handlers = createCommandHandlers(new Map([["P0", { command: "echo dry", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 }]]), executor);
  const result = await handlers.get("P0")!.run(handlerContext("dry-run"));
  assert.equal(result.status, "working");
  assert.equal(executor.launches[0].simulation, true);
});

test("live handlers validate the job spec through makeJobSpec before launching", async () => {
  const executor = fakeExecutor({ simulationSafe: false });
  const handlers = createCommandHandlers(new Map([["P0", { command: "", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 }]]), executor);
  await assert.rejects(() => handlers.get("P0")!.run(handlerContext("live")), /invalid remote job spec/);
  assert.equal(executor.launches.length, 0);
});

test("phase command gpu strings must declare the phase's required GPU count", async () => {
  const root = await mkdtemp(join("/tmp", "shell-runtime-config-gpu-"));
  await writeCommandsFile(root, { "P2.6": { command: "bash workers/grpo.sh", gpu: "1xL4", timeoutSeconds: 600, estimatedCostUsd: 8 } });
  assert.throws(() => loadPhaseCommands(root), /P2\.6 requires 2 GPU/);

  await writeCommandsFile(root, { "P2.6": { command: "bash workers/grpo.sh", gpu: "L4", timeoutSeconds: 600, estimatedCostUsd: 8 } });
  assert.throws(() => loadPhaseCommands(root), /P2\.6 requires 2 GPU.*does not declare a GPU count/s);

  await writeCommandsFile(root, {
    "P2.6": { command: "bash workers/grpo.sh", gpu: "2xL4", timeoutSeconds: 600, estimatedCostUsd: 8 },
    P0: { command: "bash workers/p0.sh", gpu: "1xL4", timeoutSeconds: 60, estimatedCostUsd: 0 },
  });
  const commands = loadPhaseCommands(root);
  assert.equal(commands.get("P2.6")?.gpu, "2xL4");
  assert.equal(commands.get("P0")?.gpu, "1xL4");
});

test("SSH executor is created only when all SSH settings are present", () => {
  const previous = { host: process.env.PI_SSH_HOST, user: process.env.PI_SSH_USER, root: process.env.PI_SSH_REMOTE_ROOT };
  delete process.env.PI_SSH_HOST;
  delete process.env.PI_SSH_USER;
  delete process.env.PI_SSH_REMOTE_ROOT;
  assert.equal(createConfiguredSshExecutor(), undefined);
  process.env.PI_SSH_HOST = "gpu.example";
  process.env.PI_SSH_USER = "ubuntu";
  process.env.PI_SSH_REMOTE_ROOT = "/workspace/project";
  assert.ok(createConfiguredSshExecutor());
  for (const [key, value] of Object.entries({ PI_SSH_HOST: previous.host, PI_SSH_USER: previous.user, PI_SSH_REMOTE_ROOT: previous.root })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
