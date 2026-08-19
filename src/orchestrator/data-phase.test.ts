import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDatasetGate } from "./data-phase.ts";

test("production dataset gate requires train/eval sizes and balance", () => {
  const result = evaluateDatasetGate({ mode: "live", train: 1800, eval: 250, holdout: 250, balanceDelta: 0.08 });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test("dry-run dataset gate uses smoke thresholds and never claims production readiness", () => {
  const result = evaluateDatasetGate({ mode: "dry-run", train: 1, eval: 1, holdout: 1, balanceDelta: 0 });
  assert.equal(result.passed, true);
  assert.equal(result.productionReady, false);
  assert.ok(result.warnings.length > 0);
});

test("dataset gate blocks undersized live data", () => {
  const result = evaluateDatasetGate({ mode: "live", train: 10, eval: 1, holdout: 1, balanceDelta: 0.2 });
  assert.equal(result.passed, false);
  assert.ok(result.failures.length >= 2);
});
