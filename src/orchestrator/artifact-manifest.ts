import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExecutionMode, PhaseLedger } from "./phase-types.ts";

export type ArtifactStorage = "hf-git" | "hf-lfs" | "external" | "local";

export interface ArtifactEntry {
  path: string;
  name: string;
  phase: string;
  bytes: number;
  sha256: string;
  storage: ArtifactStorage;
  revision?: string;
  simulation?: boolean;
  recordedAt: string;
}

export interface ArtifactManifest {
  schemaVersion: 1;
  mode: ExecutionMode;
  artifacts: ArtifactEntry[];
  updatedAt: string;
}

export function createArtifactManifest(mode: ExecutionMode, now = new Date().toISOString()): ArtifactManifest {
  return { schemaVersion: 1, mode, artifacts: [], updatedAt: now };
}

export async function recordArtifact(
  manifest: ArtifactManifest,
  filePath: string,
  metadata: { phase: string; storage: ArtifactStorage; revision?: string; simulation?: boolean; relativePath?: string; now?: string },
): Promise<ArtifactManifest> {
  const absolute = resolve(filePath);
  const [content, details] = await Promise.all([readFile(absolute), stat(absolute)]);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const entry: ArtifactEntry = {
    path: metadata.relativePath ?? filePath,
    name: basename(filePath),
    phase: metadata.phase,
    bytes: details.size,
    sha256,
    storage: metadata.storage,
    revision: metadata.revision,
    simulation: metadata.simulation,
    recordedAt: metadata.now ?? new Date().toISOString(),
  };
  const entryPath = metadata.relativePath ?? filePath;
  const artifacts = manifest.artifacts.filter((candidate) => candidate.path !== entryPath);
  return { ...manifest, artifacts: [...artifacts, entry], updatedAt: entry.recordedAt };
}

export interface ArtifactVerificationIssue {
  phase: string;
  path: string;
  reason: "missing" | "hash-mismatch";
  expectedSha256: string;
  actualSha256?: string;
}

/**
 * Recomputes sha256 over every recorded artifact of every done phase (T6.3):
 * for each entry in `phase.artifactHashes`, the file is read from its
 * repo-root-relative path and hashed. Returns one issue per missing file or
 * mismatched digest; an empty array means the ledger is consistent with what
 * is on disk. Callers (e.g. `PhaseOrchestrator.resume`) decide how to fail.
 */
export async function verifyLedgerArtifacts(root: string, ledger: PhaseLedger): Promise<ArtifactVerificationIssue[]> {
  const issues: ArtifactVerificationIssue[] = [];
  for (const phase of ledger.phases) {
    if (phase.status !== "done") continue;
    for (const [relativePath, expectedSha256] of Object.entries(phase.artifactHashes)) {
      const absolute = join(root, ...relativePath.split("/"));
      let content: Buffer;
      try {
        content = await readFile(absolute);
      } catch {
        issues.push({ phase: phase.id, path: relativePath, reason: "missing", expectedSha256 });
        continue;
      }
      const actualSha256 = createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== expectedSha256.toLowerCase()) {
        issues.push({ phase: phase.id, path: relativePath, reason: "hash-mismatch", expectedSha256, actualSha256 });
      }
    }
  }
  return issues;
}
