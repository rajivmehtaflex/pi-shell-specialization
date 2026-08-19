import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JobSpec, RemoteExecutor, RemoteJob } from "./remote-executor.ts";

const execFileAsync = promisify(execFile);

export interface SshCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshCommandRunner {
  run(command: string, args: string[], cwd: string): Promise<SshCommandResult>;
}

const systemRunner: SshCommandRunner = {
  async run(command, args, cwd) {
    try {
      const result = await execFileAsync(command, args, { cwd, maxBuffer: 8 * 1024 * 1024 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error: any) {
      return {
        code: Number(error.code) || 1,
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? error.message ?? ""),
      };
    }
  },
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "job";
}

function assertJobId(jobId: string): void {
  if (!/^ssh-[a-zA-Z0-9._-]+$/.test(jobId)) throw new Error(`invalid SSH job id: ${jobId}`);
}

export interface SshRemoteExecutorOptions {
  host: string;
  user: string;
  port?: number;
  remoteRoot: string;
  identityFile?: string;
  runner?: SshCommandRunner;
}

export class SshRemoteExecutor implements RemoteExecutor {
  private readonly host: string;
  private readonly user: string;
  private readonly port: number;
  private readonly remoteRoot: string;
  private readonly identityFile?: string;
  private readonly runner: SshCommandRunner;

  constructor(options: SshRemoteExecutorOptions) {
    if (!options.host) throw new Error("SSH host is required");
    if (!options.user) throw new Error("SSH user is required");
    if (!options.remoteRoot) throw new Error("SSH remoteRoot is required");
    if (!Number.isInteger(options.port ?? 22) || (options.port ?? 22) < 1) throw new Error("SSH port is invalid");
    this.host = options.host;
    this.user = options.user;
    this.port = options.port ?? 22;
    this.remoteRoot = options.remoteRoot;
    this.identityFile = options.identityFile;
    this.runner = options.runner ?? systemRunner;
  }

  private async remote(script: string): Promise<SshCommandResult> {
    const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-p", String(this.port)];
    if (this.identityFile) args.push("-i", this.identityFile);
    args.push(`${this.user}@${this.host}`, "--", "bash", "-lc", script);
    return this.runner.run("ssh", args, process.cwd());
  }

  async launch(spec: JobSpec): Promise<RemoteJob> {
    if (spec.simulation) throw new Error("SshRemoteExecutor cannot launch simulation jobs");
    if (!spec.phase || !spec.command || spec.timeoutSeconds < 1) throw new Error("invalid SSH job spec");
    const id = `ssh-${safePart(spec.phase)}-${Date.now().toString(36)}`;
    const jobsRoot = `${this.remoteRoot}/state/ssh-jobs`;
    const logPath = `${jobsRoot}/${id}.log`;
    const pidPath = `${jobsRoot}/${id}.pid`;
    const command = [
      `mkdir -p ${shellQuote(jobsRoot)}`,
      `nohup timeout ${Math.ceil(spec.timeoutSeconds)} bash -lc ${shellQuote(spec.command)} > ${shellQuote(logPath)} 2>&1 < /dev/null &`,
      `printf '%s' "$!" > ${shellQuote(pidPath)}`,
    ].join("; ");
    const result = await this.remote(command);
    if (result.code !== 0) throw new Error(`SSH launch failed: ${result.stderr || result.stdout}`);
    return {
      id,
      phase: spec.phase,
      status: "running",
      estimatedCostUsd: spec.estimatedCostUsd,
      artifacts: [],
      logsUrl: logPath,
      simulation: false,
    };
  }

  async status(jobId: string): Promise<RemoteJob> {
    assertJobId(jobId);
    const pidPath = `${this.remoteRoot}/state/ssh-jobs/${jobId}.pid`;
    const result = await this.remote(`test -s ${shellQuote(pidPath)} && pid=$(cat ${shellQuote(pidPath)}) && kill -0 "$pid"`);
    const running = result.code === 0;
    return {
      id: jobId,
      phase: jobId.replace(/^ssh-/, "").split("-")[0],
      status: running ? "running" : "done",
      estimatedCostUsd: 0,
      artifacts: [],
      logsUrl: `${this.remoteRoot}/state/ssh-jobs/${jobId}.log`,
      simulation: false,
    };
  }

  async cancel(jobId: string): Promise<void> {
    assertJobId(jobId);
    const pidPath = `${this.remoteRoot}/state/ssh-jobs/${jobId}.pid`;
    const result = await this.remote(`test -s ${shellQuote(pidPath)} && kill "$(cat ${shellQuote(pidPath)})" || true`);
    if (result.code !== 0) throw new Error(`SSH cancel failed: ${result.stderr || result.stdout}`);
  }

  async logs(jobId: string): Promise<string> {
    assertJobId(jobId);
    const logPath = `${this.remoteRoot}/state/ssh-jobs/${jobId}.log`;
    const result = await this.remote(`test -f ${shellQuote(logPath)} && sed -n '1,240p' ${shellQuote(logPath)} || true`);
    if (result.code !== 0) throw new Error(`SSH log retrieval failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }
}
