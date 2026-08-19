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

export function assertCommitPaths(paths: string[]): void {
  for (const path of paths) {
    if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`invalid commit path: ${path}`);
    const parts = path.split("/");
    if (parts.some((part) => BLOCKED_PARTS.has(part)) || path === ".env" || path.endsWith("/.env") || /(?:^|\/)(?:.*\.pem|.*\.key|credentials\.json)$/.test(path)) {
      throw new Error(`blocked commit path: ${path}`);
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
