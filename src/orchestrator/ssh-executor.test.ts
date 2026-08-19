import test from "node:test";
import assert from "node:assert/strict";
import { SshRemoteExecutor, type SshCommandRunner } from "./ssh-executor.ts";

test("SSH executor launches a durable background job without Modal", async () => {
  const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
  const runner: SshCommandRunner = {
    async run(command, args, cwd) {
      calls.push({ command, args, cwd });
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", port: 22, remoteRoot: "/workspace/pi-shell-specialization", runner });
  const job = await executor.launch({ phase: "P2.3", command: "python train.py", gpu: "L4", timeoutSeconds: 60, estimatedCostUsd: 1 });
  assert.match(job.id, /^ssh-/);
  assert.equal(job.status, "running");
  assert.equal(job.simulation, false);
  assert.equal(calls[0].command, "ssh");
  assert.ok(calls[0].args.some((arg) => arg.includes("nohup")));
  assert.ok(calls[0].args.some((arg) => arg.includes("python train.py")));
});

test("SSH executor status/log/cancel use the saved job id", async () => {
  const calls: string[] = [];
  const runner: SshCommandRunner = {
    async run(command, args) {
      calls.push([command, ...args].join(" "));
      if (args.some((arg) => arg.includes("cat"))) return { code: 0, stdout: "1234\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  await executor.status("ssh-P2.3-abc");
  await executor.logs("ssh-P2.3-abc");
  await executor.cancel("ssh-P2.3-abc");
  assert.equal(calls.length, 3);
  assert.ok(calls.some((call) => call.includes("kill")));
  assert.ok(calls.some((call) => call.includes("ssh-jobs")));
});

test("SSH executor rejects missing connection configuration", () => {
  assert.throws(() => new SshRemoteExecutor({ host: "", user: "ubuntu", remoteRoot: "/workspace/project" }), /host/i);
  assert.throws(() => new SshRemoteExecutor({ host: "gpu.example", user: "", remoteRoot: "/workspace/project" }), /user/i);
  assert.throws(() => new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "" }), /remoteRoot/i);
});
