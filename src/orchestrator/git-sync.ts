import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PhaseRecord } from "./phase-types.ts";

const execFileAsync = promisify(execFile);
export const HF_REMOTE = "https://huggingface.co/rajivmehtapy/pi-shell-specialization";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], cwd: string): Promise<CommandResult>;
}

const systemRunner: CommandRunner = {
  async run(command, args, cwd) {
    try {
      const result = await execFileAsync(command, args, { cwd, maxBuffer: 1024 * 1024 * 8 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      return { code: Number(error.code) || 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? error.message ?? "") };
    }
  },
};

const BLOCKED_PARTS = new Set([".git", "node_modules", "dist", ".venv", "__pycache__"]);

/**
 * Artifact roots (repo-relative, POSIX separators) that checkpoint commits may
 * touch (T6.2). The allowlist is the primary defense; the blocklist below is
 * kept as defense in depth.
 */
export const COMMITTABLE_ROOTS: readonly string[] = ["state", "data", "artifacts", "runs"];

const SECRET_PATH_PATTERNS: Array<{ rule: string; pattern: RegExp }> = [
  { rule: ".env* secret files are never committed in any directory", pattern: /(?:^|\/)\.env/i },
  { rule: "credentials* files are never committed in any directory", pattern: /(?:^|\/)credentials/i },
  { rule: "*.pem key material is never committed", pattern: /\.pem$/i },
  { rule: "*.key key material is never committed", pattern: /\.key$/i },
  { rule: "id_rsa* private keys are never committed", pattern: /(?:^|\/)id_rsa/i },
  { rule: "*.p12 key bundles are never committed", pattern: /\.p12$/i },
];

function reject(path: string, rule: string): never {
  throw new Error(`rejected commit path "${path}": ${rule}`);
}

export function assertCommitPaths(paths: string[]): void {
  for (const path of paths) {
    if (!path) reject(path, "empty commit paths are not allowed");
    if (path.startsWith("/")) reject(path, "absolute paths are not allowed; use repo-relative POSIX paths");
    if (path.includes("\\")) reject(path, "backslash separators are not allowed; use repo-relative POSIX paths");
    if (path.split("/").includes("..")) reject(path, `path traversal via ".." segments is not allowed`);
    for (const { rule, pattern } of SECRET_PATH_PATTERNS) {
      if (pattern.test(path)) reject(path, rule);
    }
    const parts = path.split("/");
    if (parts.length < 2) {
      reject(path, "repo-root-level files are never committed; place artifacts under state/, data/, artifacts/, or runs/");
    }
    if (!COMMITTABLE_ROOTS.includes(parts[0])) {
      reject(path, "path is outside the committable artifact roots (state/, data/, artifacts/, runs/); explicitly allow nothing else");
    }
    if (parts.some((part) => BLOCKED_PARTS.has(part))) {
      reject(path, `blocked directory in path (${[...BLOCKED_PARTS].join(", ")})`);
    }
  }
}

async function checked(runner: CommandRunner, root: string, command: string, args: string[]): Promise<CommandResult> {
  const result = await runner.run(command, args, root);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result;
}

export class HfGitSync {
  private readonly root: string;
  private readonly runner: CommandRunner;
  private readonly remote: string;

  constructor(options: { root: string; runner?: CommandRunner; remote?: string }) {
    this.root = options.root;
    this.runner = options.runner ?? systemRunner;
    this.remote = options.remote ?? HF_REMOTE;
  }

  async preflight(): Promise<{ remote: string; branch: string }> {
    const remote = (await checked(this.runner, this.root, "git", ["remote", "get-url", "origin"])).stdout.trim();
    if (remote !== this.remote) throw new Error(`unexpected origin: ${remote}`);
    const branch = (await checked(this.runner, this.root, "git", ["branch", "--show-current"])).stdout.trim();
    if (branch !== "main") throw new Error(`expected main branch, got ${branch || "detached"}`);
    await checked(this.runner, this.root, "git", ["lfs", "env"]);
    return { remote, branch };
  }

  async commitPhase(phase: PhaseRecord, paths: string[], message: string): Promise<string> {
    assertCommitPaths(paths);
    if (paths.length === 0) throw new Error("cannot commit an empty path list");
    await checked(this.runner, this.root, "git", ["add", "--", ...paths]);
    await checked(this.runner, this.root, "git", ["commit", "-m", message]);
    return (await checked(this.runner, this.root, "git", ["rev-parse", "HEAD"])).stdout.trim();
  }

  async push(commit: string): Promise<void> {
    if (!commit) throw new Error("cannot push without a commit");
    await checked(this.runner, this.root, "git", ["push", "origin", "main"]);
  }
}
