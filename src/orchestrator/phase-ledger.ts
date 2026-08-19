import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PHASE_DEFINITIONS, type ExecutionMode, type PhaseLedger, type PhaseRecord } from "./phase-types.ts";

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
  if (phase.status !== "working") throw new Error(`phase is not working: ${id}`);
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
