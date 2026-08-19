import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES, CATEGORY_NAMES, validateBenchmarkCases } from "./cases.ts";

test("benchmark contains 60 cases with at least seven per category", () => {
  assert.equal(BENCHMARK_CASES.length, 60);
  for (const category of CATEGORY_NAMES) {
    const count = BENCHMARK_CASES.filter((item) => item.category === category).length;
    assert.ok(count >= 7 && count <= 8, `${category}: ${count}`);
  }
});

test("benchmark metadata is complete and ids are unique", () => {
  const ids = new Set(BENCHMARK_CASES.map((item) => item.id));
  assert.equal(ids.size, BENCHMARK_CASES.length);
  assert.deepEqual(validateBenchmarkCases(BENCHMARK_CASES), []);
});

test("benchmark cases use a fresh fixture and explicit scoring dimensions", () => {
  for (const item of BENCHMARK_CASES) {
    assert.ok(item.testFixture.setup.length > 0, item.id);
    assert.ok(item.testFixture.verify.length > 0, item.id);
    assert.equal(item.timeoutMs > 0, true, item.id);
    assert.equal(Object.keys(item.scoreDimensions).length, 5, item.id);
    assert.ok(item.expectedInvariants.length >= 1, item.id);
    assert.ok(item.failureLabels.length >= 1, item.id);
  }
});
