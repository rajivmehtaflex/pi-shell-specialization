import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { ExecutionMode } from "./phase-types.ts";

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
  const artifacts = manifest.artifacts.filter((candidate) => candidate.path !== filePath);
  return { ...manifest, artifacts: [...artifacts, entry], updatedAt: entry.recordedAt };
}
