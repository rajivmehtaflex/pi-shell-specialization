import { createHash } from "node:crypto";
import type { ExecutionMode } from "./phase-types.ts";

export interface DatasetCounts {
  mode: ExecutionMode;
  train: number;
  eval: number;
  holdout: number;
  balanceDelta: number;
}

export interface DatasetGateResult {
  passed: boolean;
  productionReady: boolean;
  failures: string[];
  warnings: string[];
}

export interface DatasetSplit<T> {
  train: T[];
  eval: T[];
  holdout: T[];
  balanceDelta: number;
}

export interface SplitDatasetOptions {
  seed?: number;
  holdoutCount?: number;
  trainRatio?: number;
}

function splitKey(row: unknown): string {
  const record = row as Record<string, unknown>;
  const key = record.task_id ?? record.id;
  if (typeof key !== "string" || key.length === 0) throw new Error("split rows must carry a non-empty task_id or id");
  return key;
}

function orderedByHashedKey<T>(rows: T[], seed: number): T[] {
  const hashed = rows.map((row) => ({ row, hash: createHash("sha256").update(`${seed}:${splitKey(row)}`, "utf8").digest("hex") }));
  hashed.sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return hashed.map((entry) => entry.row);
}

/** Max category share minus min category share across the rows (0 when one category). */
export function balanceDeltaOf(rows: ReadonlyArray<object>): number {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const task = record.task;
    const category = typeof record.category === "string"
      ? record.category
      : (typeof task === "object" && task !== null && typeof (task as Record<string, unknown>).category === "string"
        ? (task as Record<string, unknown>).category as string
        : "unknown");
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  if (counts.size <= 1) return 0;
  const shares = [...counts.values()].map((count) => count / rows.length);
  return Math.max(...shares) - Math.min(...shares);
}

/**
 * Deterministic dataset split mirroring workers/split.py: rows are ordered by
 * sha256(`${seed}:${task_id}`), the last holdoutCount rows become the holdout,
 * and the remaining rows are divided by trainRatio. Produces the same split
 * result shape the worker emits: { train, eval, holdout, balanceDelta }.
 */
export function splitDatasetRows<T extends object>(rows: T[], options: SplitDatasetOptions = {}): DatasetSplit<T> {
  const seed = options.seed ?? 42;
  const holdoutCount = options.holdoutCount ?? 250;
  const trainRatio = options.trainRatio ?? 0.7;
  if (!Number.isInteger(holdoutCount) || holdoutCount < 1) throw new Error("holdoutCount must be a positive integer");
  if (rows.length <= holdoutCount) throw new Error(`input must contain more rows than holdout_count (${holdoutCount})`);
  const ordered = orderedByHashedKey(rows, seed);
  const holdout = ordered.slice(-holdoutCount);
  const remaining = ordered.slice(0, ordered.length - holdoutCount);
  const trainCount = Math.round(remaining.length * trainRatio);
  const train = remaining.slice(0, trainCount);
  const evalRows = remaining.slice(trainCount);
  return { train, eval: evalRows, holdout, balanceDelta: balanceDeltaOf([...train, ...evalRows, ...holdout]) };
}

/**
 * Builds DatasetCounts from a split result (the shape workers/split.py emits,
 * rows keyed by task_id). Reads balanceDelta when present and otherwise falls
 * back to computing it from the rows.
 */
export function datasetCountsFromSplit(
  mode: ExecutionMode,
  split: { train: unknown[]; eval: unknown[]; holdout: unknown[]; balanceDelta?: number },
): DatasetCounts {
  const allRows = [...split.train, ...split.eval, ...split.holdout].map((row) => (typeof row === "object" && row !== null ? row as Record<string, unknown> : {}));
  return {
    mode,
    train: split.train.length,
    eval: split.eval.length,
    holdout: split.holdout.length,
    balanceDelta: typeof split.balanceDelta === "number" ? split.balanceDelta : balanceDeltaOf(allRows),
  };
}

export function evaluateDatasetGate(counts: DatasetCounts): DatasetGateResult {
  if (counts.mode === "dry-run") {
    const failures: string[] = [];
    if (counts.train < 1 || counts.eval < 1 || counts.holdout < 1) failures.push("dry-run needs at least one row in each split");
    return {
      passed: failures.length === 0,
      productionReady: false,
      failures,
      warnings: ["dry-run thresholds passed; production size/balance gate remains unevaluated"],
    };
  }
  const failures: string[] = [];
  if (counts.train < 1800) failures.push("train split must contain at least 1800 rows");
  if (counts.eval !== 250) failures.push("eval split must contain exactly 250 rows");
  if (counts.holdout !== 250) failures.push("holdout split must contain exactly 250 rows");
  if (counts.balanceDelta > 0.1) failures.push("category balance exceeds ±10%");
  return { passed: failures.length === 0, productionReady: failures.length === 0, failures, warnings: [] };
}
