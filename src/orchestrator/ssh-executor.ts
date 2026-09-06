import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JobSpec, RemoteExecutor, RemoteJob } from "./remote-executor.ts";

const execFileAsync = promisify(execFile);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

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

function phaseFromJobId(jobId: string): string {
  return jobId.replace(/^ssh-/, "").split("-")[0];
}

export interface LaunchScriptOptions {
  jobsRoot: string;
  jobId: string;
  command: string;
  timeoutSeconds: number;
}

/**
 * Builds the remote wrapper script for one job launch.
 *
 * The wrapper is transferred base64-encoded (`printf %s <b64> | base64 -d | bash`),
 * so the remote LOGIN shell only ever parses inert base64 characters and cannot
 * expand `"$!"` or mangle quoting before the wrapper itself runs.
 *
 * Durability design (validated against bash's real semantics):
 * - A single background controller group `{ ... } &` spawns the job, captures `$!`,
 *   and writes <id>.pid. The controller must be the job's parent because bash's
 *   `wait` refuses to wait on sibling pids ("not a child of this shell"), which is
 *   why the monitor is not a separate `( wait <pid> )` subshell.
 * - `trap '' HUP` is set before forking so the controller, `timeout`, and the job
 *   all inherit SIG_IGN for SIGHUP; combined with nohup they survive the ssh
 *   session teardown that follows as soon as the wrapper exits.
 * - `wait "$job_pid"` yields the exact exit status (GNU timeout exits 124 on
 *   expiry; nonzero command exits surface unchanged), recorded to <id>.exit along
 *   with a UTC <id>.finished timestamp. Presence of <id>.exit is the completion
 *   marker status() keys on.
 * - The wrapper briefly waits for <id>.pid to exist so that after launch() returns
 *   the pid file is deterministic and an immediate status() never races the fork.
 */
export function buildLaunchScript(options: LaunchScriptOptions): string {
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutSeconds));
  const logPath = `${options.jobsRoot}/${options.jobId}.log`;
  const pidPath = `${options.jobsRoot}/${options.jobId}.pid`;
  const exitPath = `${options.jobsRoot}/${options.jobId}.exit`;
  const finishedPath = `${options.jobsRoot}/${options.jobId}.finished`;
  return [
    `mkdir -p ${shellQuote(options.jobsRoot)}`,
    `rm -f ${shellQuote(exitPath)} ${shellQuote(finishedPath)}`,
    `trap '' HUP`,
    `{`,
    `  nohup timeout ${timeoutSeconds} bash -lc ${shellQuote(options.command)} > ${shellQuote(logPath)} 2>&1 < /dev/null &`,
    `  job_pid=$!`,
    `  printf '%s\\n' "$job_pid" > ${shellQuote(pidPath)}`,
    `  wait "$job_pid"`,
    `  job_code=$?`,
    `  printf '%s\\n' "$job_code" > ${shellQuote(exitPath)}`,
    `  date -u +%Y-%m-%dT%H:%M:%SZ > ${shellQuote(finishedPath)}`,
    `} > /dev/null 2>&1 < /dev/null &`,
    `attempts=0`,
    `while [ ! -s ${shellQuote(pidPath)} ] && [ "$attempts" -lt 50 ]; do`,
    `  sleep 0.1`,
    `  attempts=$((attempts + 1))`,
    `done`,
    ``,
  ].join("\n");
}

const REMOTE_COMMAND_PATTERN = /^printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash$/;

/** Decodes a remote command produced by encodeRemoteScript (used by tests and diagnostics). */
export function decodeRemoteCommand(command: string): string {
  const match = REMOTE_COMMAND_PATTERN.exec(command);
  if (!match) throw new Error(`not a base64-wrapped remote command: ${command.slice(0, 120)}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

function encodeRemoteScript(script: string): string[] {
  const payload = Buffer.from(script, "utf8").toString("base64");
  // One pipeline for the remote login shell; every character outside the payload is inert.
  return ["printf", "%s", payload, "|", "base64", "-d", "|", "bash"];
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
    args.push(`${this.user}@${this.host}`, "--", ...encodeRemoteScript(script));
    return this.runner.run("ssh", args, process.cwd());
  }

  async launch(spec: JobSpec): Promise<RemoteJob> {
    if (spec.simulation) throw new Error("SshRemoteExecutor cannot launch simulation jobs");
    if (!spec.phase || !spec.command || spec.timeoutSeconds < 1) throw new Error("invalid SSH job spec");
    const id = `ssh-${safePart(spec.phase)}-${Date.now().toString(36)}`;
    const jobsRoot = `${this.remoteRoot}/state/ssh-jobs`;
    const script = buildLaunchScript({ jobsRoot, jobId: id, command: spec.command, timeoutSeconds: spec.timeoutSeconds });
    const result = await this.remote(script);
    if (result.code !== 0) throw new Error(`SSH launch failed: ${result.stderr || result.stdout}`);
    return {
      id,
      phase: spec.phase,
      status: "running",
      exitCode: null,
      estimatedCostUsd: spec.estimatedCostUsd,
      artifacts: [],
      logsUrl: `${jobsRoot}/${id}.log`,
      simulation: false,
    };
  }

  async status(jobId: string): Promise<RemoteJob> {
    assertJobId(jobId);
    const jobsRoot = `${this.remoteRoot}/state/ssh-jobs`;
    const logsUrl = `${jobsRoot}/${jobId}.log`;
    const phase = phaseFromJobId(jobId);
    const base = {
      id: jobId,
      phase,
      estimatedCostUsd: 0,
      artifacts: [] as string[],
      logsUrl,
      simulation: false as const,
    };
    const probe = [
      `root=${shellQuote(jobsRoot)}`,
      `id=${shellQuote(jobId)}`,
      `exit_file="$root/$id.exit"`,
      `finished_file="$root/$id.finished"`,
      `pid_file="$root/$id.pid"`,
      `if [ -f "$exit_file" ]; then`,
      `  printf 'outcome %s\\n' "$(cat "$exit_file" 2>/dev/null)"`,
      `  printf 'finished %s\\n' "$(cat "$finished_file" 2>/dev/null)"`,
      `elif [ -s "$pid_file" ] && pid=$(cat "$pid_file" 2>/dev/null) && kill -0 "$pid" 2>/dev/null; then`,
      `  printf 'running\\n'`,
      `else`,
      `  printf 'unknown\\n'`,
      `fi`,
    ].join("\n");
    const result = await this.remote(probe);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      return {
        ...base,
        status: "unknown",
        exitCode: null,
        error: `SSH status probe failed (exit ${result.code}): ${detail}`,
      };
    }
    const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const outcome = lines.find((line) => line.startsWith("outcome "))?.slice("outcome ".length).trim();
    const finished = lines.find((line) => line.startsWith("finished "))?.slice("finished ".length).trim();
    if (outcome !== undefined && /^\d+$/.test(outcome)) {
      const exitCode = Number(outcome);
      const finishedAt = finished && ISO_TIMESTAMP.test(finished) ? finished : undefined;
      return {
        ...base,
        status: exitCode === 0 ? "done" : "failed",
        exitCode,
        finishedAt,
        ...(exitCode === 0 ? {} : { error: `remote job exited with code ${exitCode}; inspect ${logsUrl}` }),
      };
    }
    if (lines.includes("running")) {
      return { ...base, status: "running", exitCode: null };
    }
    return {
      ...base,
      status: "unknown",
      exitCode: null,
      error: lines.includes("unknown")
        ? `no exit marker and no live pid for ${jobId} under ${jobsRoot}`
        : `unrecognized status probe output: ${result.stdout.trim().slice(0, 200)}`,
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
