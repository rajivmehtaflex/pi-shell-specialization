import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES } from "./cases.ts";

test("all diagnostic cases declare the Linux Bash 5/GNU dialect", () => {
  for (const item of BENCHMARK_CASES) {
    assert.equal(item.dialect, "linux-bash5-gnu", item.id);
    assert.match(item.prompt, /Linux Bash 5|GNU userland/i, item.id);
  }
});
