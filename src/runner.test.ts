import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { BENCHMARK_CASES } from "./cases.ts";
import { runBenchmark } from "./runner.ts";

test("tool-enabled runs prepare the fixture workspace before invoking Pi", async () => {
  const item = BENCHMARK_CASES.find((candidate) => candidate.id === "agent-001")!;
  let sawFixture = false;
  const invoker = {
    async invoke(_prompt: string, cwd: string): Promise<string> {
      await access(`${cwd}/discovered.data`);
      sawFixture = true;
      return "```bash\ncp \"$TEST_ROOT/discovered.data\" \"$TEST_ROOT/discovered.out\"\n```";
    },
  };
  const result = await runBenchmark([item], {
    tracks: ["pi-tools"],
    invokers: { "pi-tools": invoker },
    sandbox: { backend: "host-temp", allowUnsafeHostSandbox: true },
  });
  assert.equal(sawFixture, true);
  assert.equal(result.results.length, 1);
});
