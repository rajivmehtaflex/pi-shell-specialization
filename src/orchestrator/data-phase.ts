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
