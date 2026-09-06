import test from "node:test";
import assert from "node:assert/strict";
import { createInitialLedger, markPhaseWorking } from "./phase-ledger.ts";
import { HfGitSync, assertCommitPaths, type CommandRunner } from "./git-sync.ts";
import { CheckpointCommitter } from "./checkpoint-commit.ts";

test("commit path policy allows artifact roots and rejects everything else", () => {
  assert.doesNotThrow(() => assertCommitPaths([
    "state/phase-ledger.json",
    "data/teacher_verified.jsonl",
    "artifacts/report.json",
    "artifacts/model.safetensors",
    "runs/sft-v1/job.json",
  ]));
  assert.throws(() => assertCommitPaths([".env"]), /secret/i);
  assert.throws(() => assertCommitPaths(["../outside.txt"]), /traversal/);
  assert.throws(() => assertCommitPaths(["state/node_modules/x.js"]), /blocked/);
});

test("commit path allowlist rejects secrets in any directory with rule-naming messages", () => {
  for (const [path, rule] of [
    [".env", /secret files are never committed/],
    ["state/.env.local", /secret files are never committed/],
    ["secrets/id_rsa", /id_rsa/],
    ["artifacts/server.pem", /\.pem/],
    ["runs/tls.key", /\.key/],
    ["data/credentials.json", /credentials/],
    ["state/cert.p12", /\.p12/],
  ] as const) {
    assert.throws(() => assertCommitPaths([path]), rule, path);
    assert.throws(() => assertCommitPaths([path]), new RegExp(path.replace(/\./g, "\\.")), `message must name the path: ${path}`);
  }
});

test("commit path allowlist rejects non-artifact paths with rule-naming messages", () => {
  for (const [path, rule] of [
    ["../outside", /traversal/],
    ["/abs/path", /absolute/],
    ["README.md", /repo-root-level/],
    ["docs/notes.md", /outside the committable artifact roots/],
    ["runs/../../escape", /traversal/],
  ] as const) {
    assert.throws(() => assertCommitPaths([path]), rule, path);
    assert.throws(() => assertCommitPaths([path]), new RegExp(path.replace(/\./g, "\\.")), `message must name the path: ${path}`);
  }
  assert.throws(() => assertCommitPaths(["state\\windows.json"]), /POSIX/);
  assert.throws(() => assertCommitPaths([""]), /empty/);
});

test("a legit multi-path checkpoint commit still succeeds", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "rev-parse") return { code: 0, stdout: "def456\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const sync = new HfGitSync({ root: "/tmp/shell-specialization", runner });
  const phase = markPhaseWorking(createInitialLedger({ mode: "live" }), "P2.2");
  const commit = await sync.commitPhase(
    phase,
    ["state/phase-ledger.json", "data/teacher_train.jsonl", "runs/P2.2/result.json", "artifacts/audit.json"],
    "phase(P2.2): complete",
  );
  assert.equal(commit, "def456");
  const addCall = calls.find((call) => call[0] === "git" && call[1] === "add");
  assert.ok(addCall);
  assert.ok(addCall.includes("state/phase-ledger.json"));
  assert.ok(addCall.includes("runs/P2.2/result.json"));
  assert.ok(calls.some((call) => call[0] === "git" && call[1] === "commit"));
});

test("HF sync preflight and checkpoint use the expected commands", async () => {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    async run(command, args) {
      calls.push([command, ...args]);
      if (args[0] === "remote") return { code: 0, stdout: "https://huggingface.co/rajivmehtapy/pi-shell-specialization\n", stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "lfs") return { code: 0, stdout: "git-lfs/3.0\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const sync = new HfGitSync({ root: "/tmp/shell-specialization", runner });
  const preflight = await sync.preflight();
  assert.equal(preflight.branch, "main");
  const phase = markPhaseWorking(createInitialLedger({ mode: "dry-run" }), "P2.0");
  const committer = new CheckpointCommitter(sync);
  const result = await committer.checkpoint("start", phase, ["state/phase-ledger.json"]);
  assert.equal(result.commit, "abc123");
  assert.ok(calls.some((call) => call.includes("add")));
  assert.ok(calls.some((call) => call.includes("push")));
});

test("push failure is surfaced instead of reported as durable", async () => {
  const runner: CommandRunner = {
    async run(_command, args) {
      if (args[0] === "remote") return { code: 0, stdout: "https://huggingface.co/rajivmehtapy/pi-shell-specialization\n", stderr: "" };
      if (args[0] === "branch") return { code: 0, stdout: "main\n", stderr: "" };
      if (args[0] === "lfs") return { code: 0, stdout: "git-lfs\n", stderr: "" };
      if (args[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (args[0] === "push") return { code: 1, stdout: "", stderr: "rejected" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const sync = new HfGitSync({ root: "/tmp/shell-specialization", runner });
  await assert.rejects(() => sync.push("abc123"), /push|rejected/i);
});
