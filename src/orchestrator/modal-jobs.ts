import type { JobSpec, RemoteJob } from "./remote-executor.ts";

export function makeJobSpec(spec: JobSpec): JobSpec {
  if (!spec.phase || !spec.command || !spec.gpu || spec.timeoutSeconds < 1 || spec.estimatedCostUsd < 0) {
    throw new Error("invalid remote job spec");
  }
  return { ...spec };
}

export function enforceGpuBudget(input: { gpuSeconds: number; estimatedGpuSeconds: number }): void {
  const limit = input.estimatedGpuSeconds * 2;
  if (input.gpuSeconds > limit) throw new Error(`GPU usage ${input.gpuSeconds}s exceeded 2x budget ${limit}s`);
}

export function enforceJobCost(job: RemoteJob, estimatedGpuSeconds: number): void {
  if (job.gpuSeconds !== undefined) enforceGpuBudget({ gpuSeconds: job.gpuSeconds, estimatedGpuSeconds });
}
