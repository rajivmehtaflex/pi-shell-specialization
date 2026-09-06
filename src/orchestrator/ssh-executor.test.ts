import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SshRemoteExecutor,
  buildLaunchScript,
  decodeRemoteCommand,
  type SshCommandResult,
  type SshCommandRunner,
} from "./ssh-executor.ts";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string;
}

function recordingRunner(
  respond: (call: RecordedCall) => SshCommandResult,
): { runner: SshCommandRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: SshCommandRunner = {
    async run(command, args, cwd) {
      const call = { command, args, cwd };
      calls.push(call);
      return respond(call);
    },
  };
  return { runner, calls };
}

function okResult(): SshCommandResult {
  return { code: 0, stdout: "", stderr: "" };
}

function remoteCommandOf(call: RecordedCall): string {
  const separator = call.args.indexOf("--");
  assert.ok(separator >= 0, "ssh argv must carry the remote command after --");
  return call.args.slice(separator + 1).join(" ");
}

function decodedScriptOf(call: RecordedCall): string {
  return decodeRemoteCommand(remoteCommandOf(call));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(path: string, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    sleepSync(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

// GNU coreutils `timeout` does not exist on macOS developer machines, so local
// wrapper executions use this stub. It mirrors the semantics the wrapper relies
// on: expiry (or SIGTERM delivered to the timeout process itself) exits 124 and
// the signal is forwarded to the managed command.
const TIMEOUT_STUB = [
  "#!/usr/bin/env bash",
  "child=\"\"",
  "trap '[ -n \"$child\" ] && kill -TERM \"$child\" 2>/dev/null; exit 124' TERM",
  'if [ "$#" -lt 2 ]; then echo "usage: timeout SECS COMMAND [ARGS]..." >&2; exit 125; fi',
  'secs="$1"',
  "shift",
  '"$@" &',
  "child=$!",
  '( sleep "$secs"; kill -TERM "$child" 2>/dev/null; exit 99 ) &',
  "watcher=$!",
  'wait "$child"',
  "code=$?",
  'kill "$watcher" 2>/dev/null',
  'wait "$watcher"',
  "watcher_code=$?",
  'if [ "$watcher_code" -eq 99 ]; then code=124; fi',
  'exit "$code"',
  "",
].join("\n");

interface Sandbox {
  dir: string;
  bin: string;
  jobsRoot: string;
}

function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "ssh-executor-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "timeout"), TIMEOUT_STUB, { mode: 0o755 });
  return { dir, bin, jobsRoot: join(dir, "state", "ssh-jobs") };
}

// Execute the wrapper exactly the way the remote login shell would: through the
// base64 pipe, so the test proves the decode path too, not just the script body.
// Piped stdio plus a hard timeout guard the ssh hang regression: if the wrapper's
// background controller ever inherits the session's stdout/stderr, the pipe stays
// open for the job's lifetime and this call does not return promptly.
function runWrapperLocally(sandbox: Sandbox, script: string): void {
  const payload = Buffer.from(script, "utf8").toString("base64");
  execFileSync("bash", ["-c", `printf %s ${payload} | base64 -d | bash`], {
    cwd: sandbox.dir,
    env: { ...process.env, PATH: `${sandbox.bin}:${process.env.PATH ?? ""}` },
    timeout: 10000,
  });
}

test("SSH executor launches a durable background job via a base64-wrapped wrapper", async () => {
  const { runner, calls } = recordingRunner(() => okResult());
  const executor = new SshRemoteExecutor({
    host: "gpu.example",
    user: "ubuntu",
    port: 22,
    remoteRoot: "/workspace/pi-shell-specialization",
    runner,
  });
  const job = await executor.launch({ phase: "P2.3", command: "python train.py", gpu: "L4", timeoutSeconds: 60, estimatedCostUsd: 1 });
  assert.match(job.id, /^ssh-/);
  assert.equal(job.status, "running");
  assert.equal(job.exitCode, null);
  assert.equal(job.simulation, false);
  assert.equal(calls[0].command, "ssh");
  assert.equal(calls.length, 1);
  // The joined `&;` sequence that made the remote `bash -lc` script unparseable must never appear.
  assert.ok(calls[0].args.every((arg) => !arg.includes("&;")));
  // The remote command is the login-shell-proof base64 pipe, not an argv-quoted script.
  assert.match(remoteCommandOf(calls[0]), /^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| bash$/);
  const script = decodedScriptOf(calls[0]);
  assert.ok(script.includes("mkdir -p '/workspace/pi-shell-specialization/state/ssh-jobs'"));
  assert.ok(script.includes("nohup timeout 60 bash -lc 'python train.py'"));
  assert.ok(script.includes(`> '/workspace/pi-shell-specialization/state/ssh-jobs/${job.id}.pid'`));
  assert.ok(script.includes(`> '/workspace/pi-shell-specialization/state/ssh-jobs/${job.id}.exit'`));
  assert.ok(script.includes(`> '/workspace/pi-shell-specialization/state/ssh-jobs/${job.id}.finished'`));
  assert.ok(script.includes('wait "$job_pid"'));
  assert.ok(script.includes("date -u +%Y-%m-%dT%H:%M:%SZ"));
});

test("generated wrapper script passes bash -n syntax check", () => {
  const script = buildLaunchScript({
    jobsRoot: "/srv/jobs",
    jobId: "ssh-P2.3-check",
    command: "echo 'single quoted' && printf \"double \\\" quoted\" | grep -c q || true",
    timeoutSeconds: 90,
  });
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, `bash -n rejected wrapper: ${result.stderr}`);
  assert.equal(result.stderr.trim(), "");
});

test("wrapper executed locally records pid file, exit 0, and finished timestamp for a successful command", () => {
  const sandbox = makeSandbox();
  const jobId = "ssh-P2.3-ok";
  const script = buildLaunchScript({ jobsRoot: sandbox.jobsRoot, jobId, command: "printf ok > out.txt", timeoutSeconds: 30 });
  runWrapperLocally(sandbox, script);
  const pid = readFileSync(join(sandbox.jobsRoot, `${jobId}.pid`), "utf8").trim();
  assert.match(pid, /^\d+$/);
  assert.notEqual(Number(pid), process.pid);
  waitForFile(join(sandbox.jobsRoot, `${jobId}.exit`));
  assert.equal(readFileSync(join(sandbox.jobsRoot, `${jobId}.exit`), "utf8").trim(), "0");
  const finished = readFileSync(join(sandbox.jobsRoot, `${jobId}.finished`), "utf8").trim();
  assert.match(finished, ISO_TIMESTAMP);
  assert.equal(readFileSync(join(sandbox.dir, "out.txt"), "utf8"), "ok");
});

test("wrapper executed locally records the failing exit code for a command that exits 3", () => {
  const sandbox = makeSandbox();
  const jobId = "ssh-P2.3-fail";
  const script = buildLaunchScript({ jobsRoot: sandbox.jobsRoot, jobId, command: "echo boom >&2; exit 3", timeoutSeconds: 30 });
  runWrapperLocally(sandbox, script);
  waitForFile(join(sandbox.jobsRoot, `${jobId}.exit`));
  assert.equal(readFileSync(join(sandbox.jobsRoot, `${jobId}.exit`), "utf8").trim(), "3");
  const finished = readFileSync(join(sandbox.jobsRoot, `${jobId}.finished`), "utf8").trim();
  assert.match(finished, ISO_TIMESTAMP);
  assert.match(readFileSync(join(sandbox.jobsRoot, `${jobId}.log`), "utf8"), /boom/);
});

test("wrapper executed locally records exit 124 when the job is killed to simulate timeout", () => {
  const sandbox = makeSandbox();
  const jobId = "ssh-P2.3-timeout";
  const script = buildLaunchScript({ jobsRoot: sandbox.jobsRoot, jobId, command: "sleep 30", timeoutSeconds: 30 });
  runWrapperLocally(sandbox, script);
  const pid = Number(readFileSync(join(sandbox.jobsRoot, `${jobId}.pid`), "utf8").trim());
  assert.ok(pid > 1);
  sleepSync(300); // allow the stubbed timeout process to finish installing handlers
  process.kill(pid, "SIGTERM");
  waitForFile(join(sandbox.jobsRoot, `${jobId}.exit`));
  assert.equal(readFileSync(join(sandbox.jobsRoot, `${jobId}.exit`), "utf8").trim(), "124");
  assert.match(readFileSync(join(sandbox.jobsRoot, `${jobId}.finished`), "utf8").trim(), ISO_TIMESTAMP);
});

test("status() maps a live pid file to running", async () => {
  const { runner, calls } = recordingRunner(() => ({ code: 0, stdout: "running\n", stderr: "" }));
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  const job = await executor.status("ssh-P2.3-live");
  assert.equal(job.status, "running");
  assert.equal(job.exitCode, null);
  assert.equal(job.error, undefined);
  assert.equal(job.logsUrl, "/workspace/project/state/ssh-jobs/ssh-P2.3-live.log");
  const probe = decodedScriptOf(calls[0]);
  assert.ok(probe.includes(".exit"));
  assert.ok(probe.includes(".pid"));
  assert.ok(probe.includes("kill -0"));
});

test("status() maps exit marker 0 to done with exitCode and finishedAt", async () => {
  const { runner } = recordingRunner(() => ({ code: 0, stdout: "outcome 0\nfinished 2026-09-06T10:00:00Z\n", stderr: "" }));
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  const job = await executor.status("ssh-P2.3-done");
  assert.equal(job.status, "done");
  assert.equal(job.exitCode, 0);
  assert.equal(job.finishedAt, "2026-09-06T10:00:00Z");
  assert.equal(job.error, undefined);
});

test("status() maps exit marker 3 to failed with exitCode 3", async () => {
  const { runner } = recordingRunner(() => ({ code: 0, stdout: "outcome 3\nfinished 2026-09-06T10:05:00Z\n", stderr: "" }));
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  const job = await executor.status("ssh-P2.3-crashed");
  assert.equal(job.status, "failed");
  assert.equal(job.exitCode, 3);
  assert.equal(job.finishedAt, "2026-09-06T10:05:00Z");
  assert.match(job.error ?? "", /code 3/);
});

test("status() reports unknown when the remote probe finds no markers", async () => {
  const { runner } = recordingRunner(() => ({ code: 0, stdout: "unknown\n", stderr: "" }));
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  const job = await executor.status("ssh-P2.3-lost");
  assert.equal(job.status, "unknown");
  assert.notEqual(job.status, "done");
  assert.ok((job.error ?? "").length > 0);
});

test("status() reports unknown on transport failure and never done", async () => {
  const { runner } = recordingRunner(() => ({
    code: 255,
    stdout: "",
    stderr: "ssh: connect to host gpu.example port 22: Connection refused",
  }));
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  const job = await executor.status("ssh-P2.3-unreachable");
  assert.equal(job.status, "unknown");
  assert.notEqual(job.status, "done");
  assert.match(job.error ?? "", /probe failed/i);
  assert.match(job.error ?? "", /refused/i);
});

test("status() rejects job ids outside the ssh- namespace", async () => {
  const { runner } = recordingRunner(() => okResult());
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  await assert.rejects(() => executor.status("modal-abc"), /invalid SSH job id/);
  await assert.rejects(() => executor.status("ssh-../escape"), /invalid SSH job id/);
});

test("SSH executor status/log/cancel send decoded scripts for the saved job id", async () => {
  const { runner, calls } = recordingRunner(() => okResult());
  const executor = new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "/workspace/project", runner });
  await executor.status("ssh-P2.3-abc");
  await executor.logs("ssh-P2.3-abc");
  await executor.cancel("ssh-P2.3-abc");
  assert.equal(calls.length, 3);
  const scripts = calls.map(decodedScriptOf);
  assert.ok(scripts.every((script) => script.includes("ssh-jobs")));
  assert.ok(scripts.some((script) => script.includes("kill")));
  assert.ok(scripts.some((script) => script.includes("sed -n")));
  assert.ok(scripts.some((script) => script.includes(".exit") && script.includes("kill -0")));
});

test("SSH executor rejects missing connection configuration", () => {
  assert.throws(() => new SshRemoteExecutor({ host: "", user: "ubuntu", remoteRoot: "/workspace/project" }), /host/i);
  assert.throws(() => new SshRemoteExecutor({ host: "gpu.example", user: "", remoteRoot: "/workspace/project" }), /user/i);
  assert.throws(() => new SshRemoteExecutor({ host: "gpu.example", user: "ubuntu", remoteRoot: "" }), /remoteRoot/i);
});
