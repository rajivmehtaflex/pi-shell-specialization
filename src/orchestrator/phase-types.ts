export type PhaseStatus = "pending" | "working" | "done" | "failed" | "blocked" | "interrupted";
export type ExecutionMode = "dry-run" | "live";

export interface PhaseDefinition {
  id: string;
  name: string;
  dependsOn: string[];
  estimatedCostUsd: number;
}

export const PHASE_DEFINITIONS: PhaseDefinition[] = [
  { id: "P0", name: "Baseline weakness profile", dependsOn: [], estimatedCostUsd: 0 },
  { id: "P2.0", name: "Shell data foundation", dependsOn: ["P0"], estimatedCostUsd: 0 },
  { id: "P2.1", name: "Teacher inference", dependsOn: ["P2.0"], estimatedCostUsd: 5 },
  { id: "P2.2", name: "Dataset audit and split", dependsOn: ["P2.1"], estimatedCostUsd: 0 },
  { id: "P2.3", name: "QLoRA/SFT", dependsOn: ["P2.2"], estimatedCostUsd: 4 },
  { id: "P2.4", name: "Merge and upload v0.1", dependsOn: ["P2.3"], estimatedCostUsd: 0 },
  { id: "P2.5", name: "Base/student evaluation", dependsOn: ["P2.4"], estimatedCostUsd: 1 },
  { id: "P2.6", name: "GRPO sharpening", dependsOn: ["P2.5"], estimatedCostUsd: 8 },
  { id: "P2.6b", name: "Merge and upload v0.2", dependsOn: ["P2.6"], estimatedCostUsd: 0 },
  { id: "P2.7", name: "Serve at 64K", dependsOn: ["P2.6b"], estimatedCostUsd: 1 },
  { id: "P2.8", name: "Pi provider and final export", dependsOn: ["P2.7"], estimatedCostUsd: 0 },
];

export interface PhaseRecord {
  id: string;
  name: string;
  status: PhaseStatus;
  executionMode: ExecutionMode;
  attempt: number;
  startedAt?: string;
  completedAt?: string;
  jobId?: string;
  remoteUrl?: string;
  gpuSeconds?: number;
  estimatedCostUsd?: number;
  actualCostUsd?: number;
  inputCursor?: number;
  totalInputs?: number;
  lastCheckpoint?: string;
  artifacts: string[];
  artifactHashes: Record<string, string>;
  commit?: string;
  error?: string;
  nextAction?: string;
}

export interface PhaseLedger {
  schemaVersion: 1;
  workflow: "pi-shell-specialization";
  repository: "rajivmehtapy/pi-shell-specialization";
  remote: "https://huggingface.co/rajivmehtapy/pi-shell-specialization";
  branch: "main";
  targetDialect: "linux-bash5-gnu";
  mode: ExecutionMode;
  phases: PhaseRecord[];
  updatedAt: string;
}
