export interface JobSpec {
  phase: string;
  command: string;
  gpu: string;
  timeoutSeconds: number;
  estimatedCostUsd: number;
  estimatedGpuSeconds?: number;
  simulation?: boolean;
}

export interface RemoteJob {
  id: string;
  phase: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "unknown";
  gpuSeconds?: number;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  artifacts: string[];
  logsUrl?: string;
  simulation?: boolean;
  /** Exit code recorded by the remote wrapper; null while the job has not finished. */
  exitCode?: number | null;
  /** Human-readable failure reason (nonzero exit, lost markers, or transport failure). */
  error?: string;
  /** ISO-8601 UTC timestamp at which the wrapper observed job completion. */
  finishedAt?: string;
  /** Path to the job's primary output file (populated by a later verification wave). */
  resultPath?: string;
  /** Artifact paths whose sha256 has been verified remotely (populated by a later wave). */
  verifiedArtifacts?: Array<{ path: string; sha256: string }>;
}

export interface RemoteExecutor {
  launch(spec: JobSpec): Promise<RemoteJob>;
  status(jobId: string): Promise<RemoteJob>;
  cancel(jobId: string): Promise<void>;
  logs(jobId: string): Promise<string>;
}

export class InMemoryRemoteExecutor implements RemoteExecutor {
  private readonly jobs = new Map<string, RemoteJob>();
  private sequence = 0;

  async launch(spec: JobSpec): Promise<RemoteJob> {
    this.sequence += 1;
    const job: RemoteJob = {
      id: `remote-${this.sequence}`,
      phase: spec.phase,
      status: spec.simulation ? "done" : "queued",
      gpuSeconds: spec.simulation ? 0 : undefined,
      estimatedCostUsd: spec.estimatedCostUsd,
      actualCostUsd: spec.simulation ? 0 : undefined,
      artifacts: [],
      simulation: spec.simulation,
    };
    this.jobs.set(job.id, job);
    return { ...job };
  }

  async status(jobId: string): Promise<RemoteJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown remote job: ${jobId}`);
    return { ...job, artifacts: [...job.artifacts] };
  }

  async cancel(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown remote job: ${jobId}`);
    job.status = "cancelled";
  }

  async logs(jobId: string): Promise<string> {
    const job = await this.status(jobId);
    return `simulation=${Boolean(job.simulation)} phase=${job.phase} status=${job.status}`;
  }
}
