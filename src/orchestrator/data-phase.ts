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
  evalCount?: number;
  /** Minimum accepted input rows; the production gate needs 1800+250+250. */
  minimumRows?: number;
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

function categoryOf(row: object): string {
  const record = row as Record<string, unknown>;
  const task = record.task;
  if (typeof record.category === "string") return record.category;
  if (typeof task === "object" && task !== null && typeof (task as Record<string, unknown>).category === "string") {
    return (task as Record<string, unknown>).category as string;
  }
  return "unknown";
}

function categoryShares(rows: ReadonlyArray<object>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(categoryOf(row), (counts.get(categoryOf(row)) ?? 0) + 1);
  const shares = new Map<string, number>();
  for (const [category, count] of counts) shares.set(category, count / Math.max(rows.length, 1));
  return shares;
}

/**
 * Worst absolute category-share deviation |share in split − share overall|,
 * maximised over categories and over the eval and holdout splits — the same
 * definition workers/split.py emits; the production gate requires <= 0.1.
 */
export function splitBalanceDelta(train: ReadonlyArray<object>, evalRows: ReadonlyArray<object>, holdout: ReadonlyArray<object>): number {
  const overall = categoryShares([...train, ...evalRows, ...holdout]);
  let worst = 0;
  for (const split of [evalRows, holdout]) {
    if (split.length === 0) continue;
    const shares = categoryShares(split);
    for (const [category, overallShare] of overall) {
      worst = Math.max(worst, Math.abs((shares.get(category) ?? 0) - overallShare));
    }
  }
  return worst;
}

/**
 * Deterministic dataset split mirroring workers/split.py: rows are ordered by
 * sha256(`${seed}:${task_id}`), the last holdoutCount rows become the holdout,
 * the preceding evalCount rows become eval, and train takes the remainder.
 * Produces the same split result shape the worker emits:
 * { train, eval, holdout, balanceDelta }.
 */
export function splitDatasetRows<T extends object>(rows: T[], options: SplitDatasetOptions = {}): DatasetSplit<T> {
  const seed = options.seed ?? 42;
  const holdoutCount = options.holdoutCount ?? 250;
  const evalCount = options.evalCount ?? 250;
  const minimumRows = options.minimumRows ?? 2300;
  if (!Number.isInteger(holdoutCount) || holdoutCount < 1) throw new Error("holdoutCount must be a positive integer");
  if (!Number.isInteger(evalCount) || evalCount < 1) throw new Error("evalCount must be a positive integer");
  if (rows.length < minimumRows) throw new Error(`input must contain at least ${minimumRows} accepted rows`);
  const ordered = orderedByHashedKey(rows, seed);
  const holdout = ordered.slice(-holdoutCount);
  const evalRows = ordered.slice(Math.max(ordered.length - holdoutCount - evalCount, 0), ordered.length - holdoutCount);
  const train = ordered.slice(0, Math.max(ordered.length - holdoutCount - evalCount, 0));
  return { train, eval: evalRows, holdout, balanceDelta: splitBalanceDelta(train, evalRows, holdout) };
}

/**
 * Builds DatasetCounts from a split result (the shape workers/split.py emits,
 * rows keyed by task_id). Reads balanceDelta when present and otherwise falls
 * back to computing it from the three split parts.
 */
export function datasetCountsFromSplit(
  mode: ExecutionMode,
  split: { train: unknown[]; eval: unknown[]; holdout: unknown[]; balanceDelta?: number },
): DatasetCounts {
  return {
    mode,
    train: split.train.length,
    eval: split.eval.length,
    holdout: split.holdout.length,
    balanceDelta: typeof split.balanceDelta === "number" ? split.balanceDelta : splitBalanceDelta(split.train as object[], split.eval as object[], split.holdout as object[]),
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
