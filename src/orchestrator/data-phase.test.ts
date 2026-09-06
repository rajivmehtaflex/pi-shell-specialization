import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { datasetCountsFromSplit, evaluateDatasetGate, splitDatasetRows } from "./data-phase.ts";

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

function envelopeRow(taskId: string, category: string): Record<string, unknown> {
  return { task_id: taskId, task: { prompt: `prompt for ${taskId}` }, category, response: `response for ${taskId}` };
}

function splitOrderHash(seed: number, taskId: string): string {
  return createHash("sha256").update(`${seed}:${taskId}`, "utf8").digest("hex");
}

test("splitDatasetRows partitions rows deterministically in sha256 key order", () => {
  const rows = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => envelopeRow(`task-${id}`, "cat"));
  const first = splitDatasetRows(rows, { seed: 42, holdoutCount: 2, trainRatio: 0.7 });
  const second = splitDatasetRows([...rows].reverse(), { seed: 42, holdoutCount: 2, trainRatio: 0.7 });
  assert.deepEqual(first, second);

  const union = [...first.train, ...first.eval, ...first.holdout].map((row) => row.task_id as string).sort();
  assert.deepEqual(union, rows.map((row) => row.task_id).sort());

  const ids = rows.map((row) => row.task_id as string);
  const ordered = [...ids].sort((x, y) => {
    const hx = splitOrderHash(42, x);
    const hy = splitOrderHash(42, y);
    return hx < hy ? -1 : hx > hy ? 1 : 0;
  });
  assert.deepEqual(first.holdout.map((row) => row.task_id), ordered.slice(-2));
  assert.equal(first.train.length, Math.round(8 * 0.7));
  assert.equal(first.eval.length, 8 - first.train.length);
});

test("splitDatasetRows rejects inputs not larger than the holdout", () => {
  const rows = [envelopeRow("only-one", "cat")];
  assert.throws(() => splitDatasetRows(rows, { holdoutCount: 1 }), /holdout/i);
});

test("splitDatasetRows computes balanceDelta as max category share minus min share", () => {
  const balanced = ["a", "b", "c", "d"].map((id) => envelopeRow(`task-${id}`, id < "c" ? "cat-x" : "cat-y"));
  assert.equal(splitDatasetRows(balanced, { holdoutCount: 1, trainRatio: 0.5 }).balanceDelta, 0);

  const skewed = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((id) => envelopeRow(`task-${id}`, id === "a" ? "cat-x" : "cat-y"));
  assert.ok(splitDatasetRows(skewed, { holdoutCount: 1, trainRatio: 0.5 }).balanceDelta > 0.5);
  assert.ok(splitDatasetRows(skewed, { holdoutCount: 1, trainRatio: 0.5 }).balanceDelta <= 1);

  const singleCategory = ["a", "b", "c"].map((id) => envelopeRow(`task-${id}`, "only"));
  assert.equal(splitDatasetRows(singleCategory, { holdoutCount: 1, trainRatio: 0.5 }).balanceDelta, 0);
});

test("datasetCountsFromSplit reads row counts and tolerates a provided balanceDelta", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id) => envelopeRow(`task-${id}`, "cat"));
  const split = splitDatasetRows(rows, { holdoutCount: 1, trainRatio: 0.7 });
  const counts = datasetCountsFromSplit("dry-run", split);
  assert.deepEqual(
    { train: counts.train, eval: counts.eval, holdout: counts.holdout },
    { train: split.train.length, eval: split.eval.length, holdout: split.holdout.length },
  );
  assert.equal(counts.balanceDelta, split.balanceDelta);

  const explicit = datasetCountsFromSplit("live", { train: [1, 2], eval: [1], holdout: [1], balanceDelta: 0.05 });
  assert.equal(explicit.balanceDelta, 0.05);
  assert.equal(explicit.mode, "live");
});

test("datasetCountsFromSplit falls back to computing balanceDelta when the split result omits it", () => {
  const counts = datasetCountsFromSplit("dry-run", { train: [1, 2, 3], eval: [4], holdout: [5] });
  assert.equal(counts.balanceDelta, 0);
});

test("dry-run split feeds the real dataset gate end to end", () => {
  const rows = ["a", "b", "c", "d", "e", "f"].map((id) => envelopeRow(`task-${id}`, "cat"));
  const split = splitDatasetRows(rows, { holdoutCount: 1, trainRatio: 0.7 });
  const gate = evaluateDatasetGate(datasetCountsFromSplit("dry-run", split));
  assert.equal(gate.passed, true);
  assert.equal(gate.productionReady, false);
  assert.ok(gate.warnings.length > 0);
});
