import test from "node:test";
import assert from "node:assert/strict";
import { createInitialLedger, markPhaseWorking } from "./phase-ledger.ts";
import { HfGitSync, assertCommitPaths, type CommandRunner } from "./git-sync.ts";
import { CheckpointCommitter } from "./checkpoint-commit.ts";

test("commit path policy allows state/data/LFS metadata and rejects secrets", () => {
  assert.doesNotThrow(() => assertCommitPaths([
    "state/phase-ledger.json",
    "data/teacher_verified.jsonl",
    "artifacts/report.json",
    "model.safetensors",
    "runs/sft-v1/job.json",
  ]));
  assert.throws(() => assertCommitPaths([".env"]), /blocked|secret/i);
  assert.throws(() => assertCommitPaths(["../outside.txt"]), /path/i);
  assert.throws(() => assertCommitPaths(["node_modules/x.js"]), /blocked/i);
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
