import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandHandlers, loadPhaseCommands, createConfiguredSshExecutor, type PhaseCommand } from "./runtime-config.ts";

test("phase command config loads non-secret SSH phase commands", async () => {
  const root = await mkdtemp(join("/tmp", "shell-runtime-config-"));
  const state = join(root, "state");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(state, { recursive: true }));
  await writeFile(join(state, "phase-commands.json"), JSON.stringify({ P0: { command: "bash workers/p0.sh", gpu: "L4", timeoutSeconds: 60, estimatedCostUsd: 0 } }), "utf8");
  const commands = loadPhaseCommands(root);
  assert.equal(commands.get("P0")?.command, "bash workers/p0.sh");
  assert.equal(commands.get("P0")?.gpu, "L4");
});

test("configured phase handlers launch jobs through the injected SSH executor", async () => {
  const launched: PhaseCommand[] = [];
  const executor = {
    async launch(spec: PhaseCommand & { phase: string }) { launched.push(spec); return { id: "ssh-P0-test", phase: spec.phase, status: "running" as const, estimatedCostUsd: 0, artifacts: [], simulation: false }; },
    async status() { throw new Error("not used"); },
    async cancel() {},
    async logs() { return ""; },
  };
  const handlers = createCommandHandlers(new Map([["P0", { command: "bash workers/p0.sh", gpu: "L4", timeoutSeconds: 60, estimatedCostUsd: 0 }]]), executor);
  const result = await handlers.get("P0")!.run({ root: "/tmp/project", mode: "live", ledger: {} as any, phase: { id: "P0", name: "P0", status: "working", executionMode: "live", attempt: 1, computeMode: "single-gpu", requiredGpuCount: 1, artifacts: [], artifactHashes: {} } });
  assert.equal(result.status, "working");
  assert.equal(launched[0].command, "bash workers/p0.sh");
  assert.equal(result.job?.id, "ssh-P0-test");
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
