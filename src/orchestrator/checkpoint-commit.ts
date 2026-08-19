import type { PhaseRecord } from "./phase-types.ts";
import type { HfGitSync } from "./git-sync.ts";

export interface CheckpointResult {
  commit: string;
  pushed: true;
  label: string;
}

export class CheckpointCommitter {
  private readonly sync: Pick<HfGitSync, "commitPhase" | "push">;

  constructor(sync: Pick<HfGitSync, "commitPhase" | "push">) {
    this.sync = sync;
  }

  async checkpoint(label: string, phase: PhaseRecord, paths: string[]): Promise<CheckpointResult> {
    const commit = await this.sync.commitPhase(phase, paths, `phase(${phase.id}): ${label}`);
    await this.sync.push(commit);
    return { commit, pushed: true, label };
  }
}
