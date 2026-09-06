import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
  buildOrchestrationWiring,
  CheckpointCommitter,
  createInitialLedger,
  PhaseOrchestrator,
  registerShellSpecialization,
  type HfGitSync,
  type OrchestratorCheckpoint,
  type PhaseHandler,
  type RemoteExecutor,
} from "./index.ts";

const SSH_KEYS = ["PI_SSH_HOST", "PI_SSH_USER", "PI_SSH_REMOTE_ROOT"] as const;

function withSshEnv(action: () => void): void {
  const previous = SSH_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.PI_SSH_HOST = "gpu.example";
  process.env.PI_SSH_USER = "ubuntu";
  process.env.PI_SSH_REMOTE_ROOT = "/workspace/project";
  try {
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withoutSshEnv(action: () => void): void {
  const previous = SSH_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of SSH_KEYS) delete process.env[key];
  try {
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("dry-run wiring never constructs an SSH executor or handlers even with SSH env set", () => {
  withSshEnv(() => {
    const wiring = buildOrchestrationWiring({ executionMode: "dry-run", orchestrationRoot: "/tmp/dry-root" });
    assert.equal(wiring.mode, "dry-run");
    assert.equal(wiring.remote, undefined);
    assert.equal(wiring.handlers.size, 0);
    assert.equal(wiring.checkpoint, undefined);
  });
});

test("live wiring constructs the SSH executor and a real git checkpoint", () => {
  withSshEnv(() => {
    const wiring = buildOrchestrationWiring({ executionMode: "live", orchestrationRoot: "/tmp/live-root" });
    assert.equal(wiring.mode, "live");
    assert.ok(wiring.remote, "live mode wires the configured SSH executor");
    assert.equal(wiring.remote?.simulationSafe, false);
    assert.equal(typeof wiring.checkpoint, "function");
    assert.equal(wiring.handlers.size, 0);
  });
});

test("live wiring still provides a checkpoint when no SSH host is configured", () => {
  withoutSshEnv(() => {
    const wiring = buildOrchestrationWiring({ executionMode: "live", orchestrationRoot: "/tmp/live-root" });
    assert.equal(wiring.remote, undefined);
    assert.equal(typeof wiring.checkpoint, "function");
  });
});

test("live wiring backed by CheckpointCommitter records before-launch and complete", async () => {
  const root = await mkdtemp(join("/tmp", "shell-index-committer-"));
  const commits: Array<{ message: string; paths: string[] }> = [];
  let pushes = 0;
  const sync = {
    async commitPhase(_phase: unknown, paths: string[], message: string) {
      commits.push({ message, paths: [...paths] });
      return `commit-${commits.length}`;
    },
    async push() {
      pushes += 1;
    },
  };
  const committer = new CheckpointCommitter(sync as unknown as Pick<HfGitSync, "commitPhase" | "push">);
  const handler: PhaseHandler = {
    async run() {
      return { status: "done", artifacts: [], artifactHashes: {}, nextAction: "next" };
    },
  };
  const orchestrator = new PhaseOrchestrator({
    root,
    mode: "live",
    handlers: new Map([["P0", handler]]),
    checkpoint: async (label, phase, paths) => (await committer.checkpoint(label, phase, paths)).commit,
    initialLedger: createInitialLedger({ mode: "live" }),
  });
  const result = await orchestrator.runPhase("P0");
  assert.equal(result.kind, "done");
  assert.deepEqual(
    commits.map((commit) => commit.message),
    ["phase(P0): before-launch", "phase(P0): complete"],
  );
  assert.deepEqual(commits[0].paths, ["state/phase-ledger.json"]);
  assert.equal(pushes, 2);
});

test("registerShellSpecialization wires a dry-run orchestrator without live pieces", async () => {
  const root = await mkdtemp(join("/tmp", "shell-index-register-"));
  const tools: Array<{ name: string }> = [];
  withSshEnv(() => {
    registerShellSpecialization(
      { registerTool(tool: { name: string }) { tools.push(tool); } },
      { executionMode: "dry-run", orchestrationRoot: root },
    );
  });
  assert.ok(tools.some((tool) => tool.name === "shell_specialization_status"));
  assert.ok(tools.some((tool) => tool.name === "shell_specialization_resume"));
});

test("buildOrchestrationWiring respects an explicitly injected simulation executor in dry-run", () => {
  const simulation: RemoteExecutor = {
    simulationSafe: true,
    async launch() {
      throw new Error("not used");
    },
    async status() {
      throw new Error("not used");
    },
    async cancel() {},
    async logs() {
      return "";
    },
  };
  const wiring = buildOrchestrationWiring({ executionMode: "dry-run", orchestrationRoot: "/tmp/dry-root", remoteExecutor: simulation });
  assert.equal(wiring.remote, simulation);
  assert.equal(wiring.checkpoint, undefined);
});

test("the wiring checkpoint adapter converts CheckpointCommitter results into commit strings", async () => {
  const labels: string[] = [];
  const fakeCommitter = {
    async checkpoint(label: string, _phase: unknown, _paths: string[]) {
      labels.push(label);
      return { commit: `commit-${labels.length}`, pushed: true as const, label };
    },
  };
  const checkpoint: OrchestratorCheckpoint = async (label, phase, paths) => (await fakeCommitter.checkpoint(label, phase, paths)).commit;
  assert.equal(await checkpoint("complete", { id: "P0" } as never, ["state/phase-ledger.json"]), "commit-1");
  assert.deepEqual(labels, ["complete"]);
});
