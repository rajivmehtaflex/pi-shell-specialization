import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInitialLedger, markPhaseDone, markPhaseWorking, parsePhaseResultManifest, phaseResultManifestPath, readLedger, recoverStaleWorking, resetFailedPhase, writeLedgerAtomic, type PhaseResultManifest } from "./phase-ledger.ts";
import { PHASE_DEFINITIONS, type ExecutionMode, type PhaseLedger, type PhaseRecord } from "./phase-types.ts";
import { enforceGpuBudget, enforceJobCost } from "./modal-jobs.ts";
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
  estimatedGpuSeconds?: number;
  actualCostUsd?: number;
  nextAction?: string;
}

export interface PhaseHandler {
  run(context: PhaseHandlerContext): Promise<PhaseHandlerResult>;
}

export type OrchestratorCheckpoint = (label: string, phase: PhaseRecord, paths: string[]) => Promise<string | undefined>;

export interface SimulationCheckpointCall {
  label: string;
  phaseId: string;
  paths: string[];
  at: string;
}

/**
 * Dry-run default checkpoint (T6.1): records checkpoint labels in memory and
 * never commits or pushes anywhere. Live mode refuses this default and requires
 * a real checkpoint implementation (see the constructor guard).
 */
export class SimulationCheckpoint {
  readonly calls: SimulationCheckpointCall[] = [];

  get labels(): string[] {
    return this.calls.map((call) => call.label);
  }

  async checkpoint(label: string, phase: PhaseRecord, paths: string[]): Promise<string | undefined> {
    this.calls.push({ label, phaseId: phase.id, paths: [...paths], at: new Date().toISOString() });
    return undefined;
  }
}

export type OrchestratorResult =
  | { kind: "blocked"; reason: string; ledger: PhaseLedger }
  | { kind: "working"; ledger: PhaseLedger }
  | { kind: "done"; ledger: PhaseLedger }
  | { kind: "interrupted"; error: string; ledger: PhaseLedger }
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
  /** Set only when dry-run fell back to the in-memory simulation checkpoint. */
  readonly simulationCheckpoint?: SimulationCheckpoint;

  constructor(options: PhaseOrchestratorOptions) {
    this.root = options.root;
    this.statePath = join(options.root, "state", "phase-ledger.json");
    this.mode = options.mode;
    this.handlers = options.handlers;
    if (options.checkpoint) {
      this.checkpoint = options.checkpoint;
    } else if (this.mode === "live") {
      // Silent no-op checkpoints would let live phases complete without any
      // durable record; refuse to run live without a real implementation.
      throw new Error("live mode requires a checkpoint implementation");
    } else {
      const simulation = new SimulationCheckpoint();
      this.simulationCheckpoint = simulation;
      this.checkpoint = (label, phase, paths) => simulation.checkpoint(label, phase, paths);
    }
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
      if (phase.status === "interrupted") {
        if (phase.jobId && this.remote) return this.reconcilePhase(phase.id);
        if (!phase.jobId) return this.runPhase(phase.id);
      }
      // Interrupted phases with a registered job but no remote executor cannot be reconciled here.
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
      if (phase.jobId && this.remote) return this.reconcilePhase(id);
      throw new Error(`phase ${id} is already working${phase.jobId ? ` (job ${phase.jobId})` : ""}; resume or cancel before relaunching`);
    }
    if (phase.status === "failed") {
      throw new Error(`phase ${id} failed and will not be relaunched implicitly${phase.error ? ` (${phase.error})` : ""}; call retryPhase("${id}") to relaunch`);
    }
    if (phase.status === "interrupted" && phase.jobId) {
      if (this.remote) return this.reconcilePhase(id);
      throw new Error(`phase ${id} is interrupted with registered job ${phase.jobId} but no remote executor is configured; resume or cancel`);
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
        workingPhase.estimatedGpuSeconds = result.estimatedGpuSeconds ?? workingPhase.estimatedGpuSeconds;
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
      donePhase.estimatedGpuSeconds = result.estimatedGpuSeconds ?? donePhase.estimatedGpuSeconds;
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

  /** Returns a violation message when a terminal job's GPU usage blew past 2x the estimate. */
  private gpuBudgetViolation(phase: PhaseRecord, job: RemoteJob): string | undefined {
    if (typeof phase.estimatedGpuSeconds !== "number" || typeof job.gpuSeconds !== "number") return undefined;
    try {
      enforceGpuBudget({ gpuSeconds: job.gpuSeconds, estimatedGpuSeconds: phase.estimatedGpuSeconds });
      enforceJobCost(job, phase.estimatedGpuSeconds);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Polls the registered remote job for a phase and settles the ledger from its
   * outcome (T5.4). A finished job only completes the phase when a valid result
   * manifest (see `parsePhaseResultManifest`) exists at
   * `state/runs/<phaseId>/result.json`; otherwise the phase stays interrupted
   * with a nextAction explaining the missing manifest.
   */
  async reconcilePhase(id: string, options: { manifestPath?: string } = {}): Promise<OrchestratorResult> {
    let ledger = await this.initialize();
    const phase = this.phaseOrThrow(ledger, id);
    if (phase.status === "done") return { kind: "done", ledger };
    if (!phase.jobId) throw new Error(`phase ${id} has no registered remote job to reconcile`);
    if (!this.remote) throw new Error(`no remote executor configured; cannot reconcile phase ${id} (job ${phase.jobId})`);
    const job = await this.remote.status(phase.jobId);

    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      const violation = this.gpuBudgetViolation(phase, job);
      if (violation) {
        phase.status = "failed";
        phase.error = violation;
        phase.nextAction = `inspect remote GPU usage and call retryPhase("${id}")`;
        await writeLedgerAtomic(this.statePath, ledger);
        return { kind: "failed", error: violation, ledger };
      }
    }
    if (job.status === "queued" || job.status === "running") {
      phase.status = "working";
      phase.error = undefined;
      phase.nextAction = "poll remote job";
      await writeLedgerAtomic(this.statePath, ledger);
      return { kind: "working", ledger };
    }
    if (job.status === "unknown") {
      phase.status = "interrupted";
      phase.error = job.error ?? `remote job status unknown: ${phase.jobId}`;
      phase.nextAction = "poll the remote job again once the host is reachable";
      await writeLedgerAtomic(this.statePath, ledger);
      return { kind: "interrupted", error: phase.error, ledger };
    }
    if (job.status === "failed" || job.status === "cancelled") {
      phase.status = "failed";
      const exit = job.exitCode !== undefined && job.exitCode !== null ? ` (exit ${job.exitCode})` : "";
      phase.error = `remote job ${job.status}${exit}: ${job.error ?? phase.jobId}`;
      phase.nextAction = `inspect remote logs and call retryPhase("${id}")`;
      await writeLedgerAtomic(this.statePath, ledger);
      return { kind: "failed", error: phase.error, ledger };
    }

    // job.status === "done": only a valid result manifest may complete the phase.
    const manifestPath = options.manifestPath ?? phaseResultManifestPath(this.root, id);
    let manifest: PhaseResultManifest;
    try {
      manifest = parsePhaseResultManifest(await readFile(manifestPath, "utf8"), id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      phase.status = "interrupted";
      phase.error = `remote job ${phase.jobId} finished but its result manifest is unusable: ${detail}`;
      phase.nextAction = `write a valid result manifest to ${manifestPath} and resume`;
      await writeLedgerAtomic(this.statePath, ledger);
      return { kind: "interrupted", error: phase.error, ledger };
    }
    if (manifest.status === "failed") {
      phase.status = "failed";
      phase.error = manifest.error ?? `result manifest reports failure for phase ${id}`;
      phase.nextAction = `inspect ${manifestPath} and call retryPhase("${id}")`;
      await writeLedgerAtomic(this.statePath, ledger);
      return { kind: "failed", error: phase.error, ledger };
    }
    ledger = markPhaseDone(ledger, id, {
      artifacts: manifest.artifacts.map((artifact) => artifact.path),
      artifactHashes: Object.fromEntries(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256])),
      now: this.now(),
    });
    const donePhase = this.phaseOrThrow(ledger, id);
    donePhase.completedAt = manifest.completedAt;
    donePhase.gpuSeconds = job.gpuSeconds ?? donePhase.gpuSeconds;
    donePhase.actualCostUsd = job.actualCostUsd ?? donePhase.actualCostUsd;
    await writeLedgerAtomic(this.statePath, ledger);
    const doneCommit = await this.checkpoint("complete", donePhase, ["state/phase-ledger.json", ...donePhase.artifacts]);
    if (doneCommit) {
      donePhase.commit = doneCommit;
      await writeLedgerAtomic(this.statePath, ledger);
    }
    return { kind: "done", ledger };
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
    await writeLedgerAtomic(this.statePath, ledger);
    if (this.remote) {
      for (const phase of ledger.phases) {
        if (phase.status !== "interrupted" || !phase.jobId) continue;
        const result = await this.reconcilePhase(phase.id);
        ledger = result.ledger;
      }
    }
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
