import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PHASE_DEFINITIONS, type ExecutionMode, type PhaseLedger, type PhaseRecord } from "./phase-types.ts";

/**
 * Result manifest contract (T5.4): every remote phase job must publish one of
 * these at `state/runs/<phaseId>/result.json` (relative to the project root)
 * before the orchestrator will mark the phase done. Wave-3 phase scripts emit
 * this file; `reconcilePhase` validates it against the ledger phase.
 */
export interface PhaseResultManifest {
  phase: string;
  status: "success" | "failed";
  artifacts: Array<{ path: string; sha256: string }>;
  completedAt: string;
  error?: string;
}

export function phaseResultManifestPath(root: string, phaseId: string): string {
  return join(root, "state", "runs", phaseId, "result.json");
}

const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

/** Parses and validates a raw result manifest against the expected phase id. */
export function parsePhaseResultManifest(raw: string, expectedPhase: string): PhaseResultManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`result manifest is not valid JSON for phase ${expectedPhase}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`result manifest must be a JSON object for phase ${expectedPhase}`);
  }
  const item = value as Record<string, unknown>;
  if (item.phase !== expectedPhase) {
    throw new Error(`result manifest phase mismatch: expected ${expectedPhase} but found ${String(item.phase)}`);
  }
  if (item.status !== "success" && item.status !== "failed") {
    throw new Error(`result manifest status must be "success" or "failed" for phase ${expectedPhase}`);
  }
  if (!Array.isArray(item.artifacts) || (item.status === "success" && item.artifacts.length === 0)) {
    throw new Error(`result manifest artifacts must be a non-empty array for phase ${expectedPhase}`);
  }
  const artifacts = item.artifacts.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error(`result manifest artifact must be an object for phase ${expectedPhase}`);
    const artifact = entry as Record<string, unknown>;
    if (typeof artifact.path !== "string" || !artifact.path.trim()) throw new Error(`result manifest artifact path missing for phase ${expectedPhase}`);
    if (typeof artifact.sha256 !== "string" || !SHA256_PATTERN.test(artifact.sha256)) {
      throw new Error(`result manifest artifact sha256 for ${artifact.path} is not a plausible 64-hex digest for phase ${expectedPhase}`);
    }
    return { path: artifact.path, sha256: artifact.sha256 };
  });
  if (typeof item.completedAt !== "string" || !item.completedAt.trim()) {
    throw new Error(`result manifest completedAt missing for phase ${expectedPhase}`);
  }
  return {
    phase: expectedPhase,
    status: item.status,
    artifacts,
    completedAt: item.completedAt,
    ...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
  };
}

export interface InitialLedgerOptions {
  mode: ExecutionMode;
  now?: string;
}

export function createInitialLedger(options: InitialLedgerOptions): PhaseLedger {
  const now = options.now ?? new Date().toISOString();
  return {
    schemaVersion: 1,
    workflow: "pi-shell-specialization",
    repository: "rajivmehtapy/pi-shell-specialization",
    remote: "https://huggingface.co/rajivmehtapy/pi-shell-specialization",
    branch: "main",
    targetDialect: "linux-bash5-gnu",
    mode: options.mode,
    phases: PHASE_DEFINITIONS.map((definition) => ({
      id: definition.id,
      name: definition.name,
      status: "pending",
      executionMode: options.mode,
      attempt: 0,
      computeMode: definition.computeMode,
      requiredGpuCount: definition.requiredGpuCount,
      estimatedCostUsd: definition.estimatedCostUsd,
      artifacts: [],
      artifactHashes: {},
    })),
    updatedAt: now,
  };
}

function phaseOrThrow(ledger: PhaseLedger, id: string): PhaseRecord {
  const phase = ledger.phases.find((candidate) => candidate.id === id);
  if (!phase) throw new Error(`unknown phase: ${id}`);
  return phase;
}

function cloneLedger(ledger: PhaseLedger, now = new Date().toISOString()): PhaseLedger {
  return { ...ledger, phases: ledger.phases.map((phase) => ({ ...phase, artifacts: [...phase.artifacts], artifactHashes: { ...phase.artifactHashes } })), updatedAt: now };
}

export function markPhaseWorking(
  ledger: PhaseLedger,
  id: string,
  options: { jobId?: string; totalInputs?: number; now?: string } = {},
): PhaseLedger {
  const updated = cloneLedger(ledger, options.now);
  const phase = phaseOrThrow(updated, id);
  if (phase.status === "done") throw new Error(`phase already done: ${id}`);
  phase.status = "working";
  phase.executionMode = ledger.mode;
  phase.attempt += 1;
  phase.startedAt = options.now ?? new Date().toISOString();
  phase.completedAt = undefined;
  phase.jobId = options.jobId;
  phase.totalInputs = options.totalInputs;
  phase.error = undefined;
  phase.nextAction = "poll phase status";
  return updated;
}

export function markPhaseDone(
  ledger: PhaseLedger,
  id: string,
  options: { artifacts: string[]; artifactHashes: Record<string, string>; commit?: string; nextAction?: string; now?: string },
): PhaseLedger {
  const updated = cloneLedger(ledger, options.now);
  const phase = phaseOrThrow(updated, id);
  if (phase.status !== "working" && phase.status !== "interrupted") throw new Error(`phase is not completable: ${id} (${phase.status})`);
  phase.status = "done";
  phase.completedAt = options.now ?? new Date().toISOString();
  phase.artifacts = [...options.artifacts];
  phase.artifactHashes = { ...options.artifactHashes };
  phase.commit = options.commit;
  phase.nextAction = options.nextAction;
  phase.error = undefined;
  return updated;
}

export function recoverStaleWorking(ledger: PhaseLedger, now = new Date().toISOString()): PhaseLedger {
  const updated = cloneLedger(ledger, now);
  for (const phase of updated.phases) {
    if (phase.status !== "working") continue;
    phase.status = "interrupted";
    phase.error = phase.jobId ? "previous orchestrator stopped; remote job requires status polling" : "previous orchestrator stopped before a remote job was registered";
    phase.nextAction = phase.jobId ? "poll saved remote job" : "review and resume phase";
  }
  return updated;
}

/** Re-enables an explicitly retried phase: failed -> pending with the stale job binding cleared. */
export function resetFailedPhase(ledger: PhaseLedger, id: string, options: { now?: string } = {}): PhaseLedger {
  const updated = cloneLedger(ledger, options.now);
  const phase = phaseOrThrow(updated, id);
  if (phase.status !== "failed") throw new Error(`phase is not failed: ${id} (${phase.status})`);
  phase.status = "pending";
  phase.jobId = undefined;
  phase.error = undefined;
  phase.nextAction = undefined;
  return updated;
}

export async function writeLedgerAtomic(path: string, ledger: PhaseLedger): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export async function readLedger(path: string): Promise<PhaseLedger> {
  const value = JSON.parse(await readFile(path, "utf8")) as PhaseLedger;
  if (value.schemaVersion !== 1 || value.workflow !== "pi-shell-specialization" || !Array.isArray(value.phases)) {
    throw new Error("invalid phase ledger");
  }
  return value;
}
