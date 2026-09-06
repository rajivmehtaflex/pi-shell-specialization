import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInitialLedger, markPhaseDone, markPhaseWorking, readLedger, recoverStaleWorking, resetFailedPhase, writeLedgerAtomic } from "./phase-ledger.ts";
import { PHASE_DEFINITIONS, type ExecutionMode, type PhaseLedger, type PhaseRecord } from "./phase-types.ts";
import type { RemoteExecutor, RemoteJob } from "./remote-executor.ts";

export interface PhaseHandlerContext {
  root: string;
  mode: ExecutionMode;
  ledger: PhaseLedger;
  phase: PhaseRecord;
}

export interface PhaseHandlerResult {
  status: "working" | "done";
  job?: RemoteJob;
  artifacts?: string[];
  artifactHashes?: Record<string, string>;
  inputCursor?: number;
  totalInputs?: number;
  lastCheckpoint?: string;
  gpuSeconds?: number;
  actualCostUsd?: number;
  nextAction?: string;
}

export interface PhaseHandler {
  run(context: PhaseHandlerContext): Promise<PhaseHandlerResult>;
}

export type OrchestratorCheckpoint = (label: string, phase: PhaseRecord, paths: string[]) => Promise<string | undefined>;

export type OrchestratorResult =
  | { kind: "blocked"; reason: string; ledger: PhaseLedger }
  | { kind: "working"; ledger: PhaseLedger }
  | { kind: "done"; ledger: PhaseLedger }
  | { kind: "failed"; error: string; ledger: PhaseLedger };

export interface PhaseOrchestratorOptions {
  root: string;
  mode: ExecutionMode;
  handlers: Map<string, PhaseHandler>;
  checkpoint?: OrchestratorCheckpoint;
  remote?: RemoteExecutor;
  initialLedger?: PhaseLedger;
  now?: () => string;
}

export class PhaseOrchestrator {
  private readonly root: string;
  private readonly statePath: string;
  private readonly mode: ExecutionMode;
  private readonly handlers: Map<string, PhaseHandler>;
  private readonly checkpoint: OrchestratorCheckpoint;
  private readonly remote?: RemoteExecutor;
  private readonly now: () => string;
  private readonly initialLedger?: PhaseLedger;

  constructor(options: PhaseOrchestratorOptions) {
    this.root = options.root;
    this.statePath = join(options.root, "state", "phase-ledger.json");
    this.mode = options.mode;
    this.handlers = options.handlers;
    this.checkpoint = options.checkpoint ?? (async () => undefined);
    this.remote = options.remote;
    this.now = options.now ?? (() => new Date().toISOString());
    this.initialLedger = options.initialLedger;
  }

  async initialize(): Promise<PhaseLedger> {
    try {
      await access(this.statePath);
      const ledger = await readLedger(this.statePath);
      if (ledger.mode !== this.mode) throw new Error(`ledger mode ${ledger.mode} does not match requested mode ${this.mode}`);
      return ledger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const ledger = this.initialLedger ?? createInitialLedger({ mode: this.mode, now: this.now() });
      await writeLedgerAtomic(this.statePath, ledger);
      return ledger;
    }
  }

  async status(): Promise<PhaseLedger> {
    return this.initialize();
  }

  private phaseOrThrow(ledger: PhaseLedger, id: string): PhaseRecord {
    const phase = ledger.phases.find((candidate) => candidate.id === id);
    if (!phase) throw new Error(`unknown phase: ${id}`);
    return phase;
  }

  private dependencyReason(ledger: PhaseLedger, id: string): string | undefined {
    const definition = PHASE_DEFINITIONS.find((candidate) => candidate.id === id);
    if (!definition) return `unknown phase: ${id}`;
    const missing = definition.dependsOn.filter((dependency) => ledger.phases.find((phase) => phase.id === dependency)?.status !== "done");
    return missing.length ? `blocked by: ${missing.join(", ")}` : undefined;
  }

  async runNext(): Promise<OrchestratorResult> {
    const ledger = await this.initialize();
    for (const phase of ledger.phases) {
      if (phase.status === "pending") return this.runPhase(phase.id);
      if (phase.status === "interrupted" && !phase.jobId) return this.runPhase(phase.id);
      // Interrupted phases with a registered remote job are reconciled, never relaunched.
    }
    const unfinished = ledger.phases.filter((phase) => phase.status !== "done");
    if (!unfinished.length) return { kind: "done", ledger };
    const summary = unfinished.map((phase) => `${phase.id}:${phase.status}`).join(", ");
    return { kind: "blocked", reason: `no runnable phase (${summary})`, ledger };
  }

  async runPhase(id: string): Promise<OrchestratorResult> {
    let ledger = await this.initialize();
    const phase = this.phaseOrThrow(ledger, id);
    if (phase.status === "done") return { kind: "done", ledger };
    if (phase.status === "working") {
      throw new Error(`phase ${id} is already working${phase.jobId ? ` (job ${phase.jobId})` : ""}; resume or cancel before relaunching`);
    }
    if (phase.status === "failed") {
      throw new Error(`phase ${id} failed and will not be relaunched implicitly${phase.error ? ` (${phase.error})` : ""}; call retryPhase("${id}") to relaunch`);
    }
    if (phase.status === "interrupted" && phase.jobId) {
      throw new Error(`phase ${id} is interrupted with registered job ${phase.jobId}; resume to reconcile it before relaunching`);
    }
    if (phase.status === "blocked") throw new Error(`phase ${id} is blocked; resolve its blockers before running`);
    const dependencyReason = this.dependencyReason(ledger, id);
    if (dependencyReason) return { kind: "blocked", reason: dependencyReason, ledger };
    const handler = this.handlers.get(id);
    if (!handler) {
      const error = `no phase handler registered for ${id}`;
      return { kind: "blocked", reason: error, ledger };
    }

    ledger = markPhaseWorking(ledger, id, { now: this.now() });
    await writeLedgerAtomic(this.statePath, ledger);
    let workingPhase = this.phaseOrThrow(ledger, id);
    try {
      const startCommit = await this.checkpoint("before-launch", workingPhase, ["state/phase-ledger.json"]);
      if (startCommit) {
        workingPhase.commit = startCommit;
        await writeLedgerAtomic(this.statePath, ledger);
      }
      const result = await handler.run({ root: this.root, mode: this.mode, ledger, phase: workingPhase });
      if (result.status === "working") {
        workingPhase.jobId = result.job?.id;
        workingPhase.remoteUrl = result.job?.logsUrl;
        workingPhase.inputCursor = result.inputCursor;
        workingPhase.totalInputs = result.totalInputs;
        workingPhase.lastCheckpoint = result.lastCheckpoint;
        workingPhase.gpuSeconds = result.gpuSeconds ?? result.job?.gpuSeconds;
        workingPhase.actualCostUsd = result.actualCostUsd ?? result.job?.actualCostUsd;
        workingPhase.nextAction = result.nextAction ?? "poll remote job";
        await writeLedgerAtomic(this.statePath, ledger);
        const launchCommit = await this.checkpoint("remote-job-registered", workingPhase, ["state/phase-ledger.json"]);
        if (launchCommit) {
          workingPhase.commit = launchCommit;
          await writeLedgerAtomic(this.statePath, ledger);
        }
        return { kind: "working", ledger };
      }

      ledger = markPhaseDone(ledger, id, {
        artifacts: result.artifacts ?? [],
        artifactHashes: result.artifactHashes ?? {},
        nextAction: result.nextAction,
        now: this.now(),
      });
      const donePhase = this.phaseOrThrow(ledger, id);
      donePhase.inputCursor = result.inputCursor;
      donePhase.totalInputs = result.totalInputs;
      donePhase.lastCheckpoint = result.lastCheckpoint;
      donePhase.gpuSeconds = result.gpuSeconds;
      donePhase.actualCostUsd = result.actualCostUsd;
      await writeLedgerAtomic(this.statePath, ledger);
      const doneCommit = await this.checkpoint("complete", donePhase, ["state/phase-ledger.json", ...(result.artifacts ?? [])]);
      if (doneCommit) {
        donePhase.commit = doneCommit;
        await writeLedgerAtomic(this.statePath, ledger);
      }
      return { kind: "done", ledger };
    } catch (error) {
      const failed = this.phaseOrThrow(ledger, id);
      failed.status = "failed";
      failed.error = error instanceof Error ? error.message : String(error);
      failed.nextAction = "inspect failure and resume explicitly";
      await writeLedgerAtomic(this.statePath, ledger);
      return { kind: "failed", error: failed.error, ledger };
    }
  }

  /** Explicitly re-enables a failed phase and immediately relaunches it. */
  async retryPhase(id: string): Promise<OrchestratorResult> {
    let ledger = await this.initialize();
    const phase = this.phaseOrThrow(ledger, id);
    if (phase.status !== "failed") {
      throw new Error(`phase ${id} is not failed (status: ${phase.status}); retryPhase only re-enables failed phases`);
    }
    ledger = resetFailedPhase(ledger, id, { now: this.now() });
    await writeLedgerAtomic(this.statePath, ledger);
    return this.runPhase(id);
  }

  async resume(): Promise<PhaseLedger> {
    let ledger = await this.initialize();
    ledger = recoverStaleWorking(ledger, this.now());
    if (this.remote) {
      for (const phase of ledger.phases) {
        if (phase.status !== "interrupted" || !phase.jobId) continue;
        const job = await this.remote.status(phase.jobId);
        if (job.status === "running" || job.status === "queued") {
          phase.status = "working";
          phase.nextAction = "poll remote job";
        } else if (job.status === "failed" || job.status === "cancelled") {
          phase.status = "failed";
          phase.error = `remote job ${job.status}: ${phase.jobId}`;
          phase.nextAction = "inspect remote logs and rerun explicitly";
        } else {
          phase.status = "working";
          phase.nextAction = "verify completed remote artifacts";
        }
      }
    }
    await writeLedgerAtomic(this.statePath, ledger);
    return ledger;
  }

  async cancel(phaseId: string): Promise<void> {
    const ledger = await this.initialize();
    const phase = this.phaseOrThrow(ledger, phaseId);
    if (!phase.jobId || !this.remote) throw new Error(`phase ${phaseId} has no cancellable remote job`);
    await this.remote.cancel(phase.jobId);
    phase.status = "interrupted";
    phase.nextAction = "resume after reviewing cancelled job";
    phase.error = `remote job cancelled: ${phase.jobId}`;
    await writeLedgerAtomic(this.statePath, ledger);
  }
}
