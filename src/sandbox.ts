import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ExecutionResult, SandboxOptions, SafetyFinding, TestFixture } from "./types.ts";
import { scanShellSafety } from "./safety.ts";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

// The candidate gets exactly one read-write mount: root/workspace (at
// /sandbox). root/verifier holds verify.sh and is mounted read-only at
// /verifier, so a candidate stage cannot overwrite or displace the verifier
// before it runs. Host-temp mirrors the on-disk split (verifier outside the
// candidate cwd) but offers no mount guarantees and must never be treated as
// secure.
const WORKSPACE_DIRNAME = "workspace";
const VERIFIER_DIRNAME = "verifier";
const WORKSPACE_MOUNT = "/sandbox";
const VERIFIER_MOUNT = "/verifier";

export interface ProcessResult {
  status: "exited" | "timed-out" | "error";
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type SandboxProcessRunner = (
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
) => Promise<ProcessResult>;

export interface SandboxTestOverrides {
  detectBackend?: () => "bwrap" | "unavailable";
  runProcess?: SandboxProcessRunner;
}

function commandAvailable(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
  return result.status === 0;
}

export function detectSandboxBackend(): "bwrap" | "unavailable" {
  return process.platform === "linux" && commandAvailable("bwrap") ? "bwrap" : "unavailable";
}

function appendOutput(current: string, chunk: Buffer, maxBytes: number): string {
  if (Buffer.byteLength(current) >= maxBytes) return current;
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(current));
  return current + chunk.toString("utf8", 0, remaining);
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, maxOutputBytes: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: "error", code: null, stdout: "", stderr: "", error: String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result: ProcessResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: "timed-out", code: null, stdout, stderr, error: `Process exceeded ${timeoutMs}ms.` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout = appendOutput(stdout, chunk, maxOutputBytes); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendOutput(stderr, chunk, maxOutputBytes); });
    child.on("error", (error) => finish({ status: "error", code: null, stdout, stderr, error: error.message }));
    child.on("close", (code) => finish({ status: "exited", code, stdout, stderr }));
  });
}

export function bwrapArgs(workspace: string, verifier: string, command: string, args: string[]): string[] {
  const mounts = ["/usr", "/bin", "/lib", "/lib64", "/etc"]
    .filter((path) => existsSync(path))
    .flatMap((path) => ["--ro-bind", path, path]);
  return [
    "--die-with-parent",
    "--unshare-all",
    "--new-session",
    ...mounts,
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", verifier, VERIFIER_MOUNT,
    "--bind", workspace, WORKSPACE_MOUNT,
    "--chdir", WORKSPACE_MOUNT,
    "--setenv", "HOME", `${WORKSPACE_MOUNT}/home`,
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TEST_ROOT", WORKSPACE_MOUNT,
    command,
    ...args,
  ];
}

async function runStage(
  backend: "host-temp" | "bwrap",
  workspace: string,
  verifier: string,
  script: { hostPath: string; sandboxPath: string },
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  runner: SandboxProcessRunner,
  args: string[] = [],
): Promise<ProcessResult> {
  if (backend === "host-temp") {
    return runner("bash", [script.hostPath, ...args], workspace, env, timeoutMs, maxOutputBytes);
  }
  return runner("bwrap", bwrapArgs(workspace, verifier, "bash", [script.sandboxPath, ...args]), workspace, env, timeoutMs, maxOutputBytes);
}

function baseEnvironment(workspace: string, fixture: TestFixture, backend: "host-temp" | "bwrap"): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: backend === "bwrap" ? `${WORKSPACE_MOUNT}/home` : join(workspace, "home"),
    LANG: "C",
    LC_ALL: "C",
    TEST_ROOT: backend === "bwrap" ? WORKSPACE_MOUNT : workspace,
    TMPDIR: backend === "bwrap" ? "/tmp" : join(workspace, "tmp"),
    ...fixture.environment,
  };
}

function unavailableResult(message: string): ExecutionResult {
  return {
    status: "sandbox-unavailable",
    syntax: "not-run",
    verification: "not-run",
    exitCode: null,
    stdout: "",
    stderr: "",
    durationMs: 0,
    findings: [],
    error: message,
  };
}

export async function runScriptInSandbox(script: string, fixture: TestFixture, options: SandboxOptions = {}): Promise<ExecutionResult> {
  return runScriptInSandboxWithOverrides(script, fixture, options, {});
}

/** Test seam: same pipeline with an injectable backend detector and process runner. */
export async function runScriptInSandboxWithOverrides(
  script: string,
  fixture: TestFixture,
  options: SandboxOptions,
  overrides: SandboxTestOverrides,
): Promise<ExecutionResult> {
  const detectBackend = overrides.detectBackend ?? detectSandboxBackend;
  const runner = overrides.runProcess ?? runProcess;
  const requested = options.backend ?? "auto";
  let backend: "host-temp" | "bwrap";
  if (requested === "host-temp") {
    if (!options.allowUnsafeHostSandbox) return unavailableResult("Host-temp execution requires allowUnsafeHostSandbox=true.");
    backend = "host-temp";
  } else {
    const detected = detectBackend();
    if (requested === "bwrap" && detected !== "bwrap") return unavailableResult("bubblewrap is not available on this Linux host.");
    if (requested === "auto" && detected === "unavailable") return unavailableResult("No secure sandbox backend is available; install bubblewrap on Linux.");
    backend = "bwrap";
  }

  const findings: SafetyFinding[] = scanShellSafety(script);
  if (findings.some((item) => item.severity === "high")) {
    return {
      status: "blocked",
      syntax: "not-run",
      verification: "not-run",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      findings,
      error: "Candidate was blocked by the shell safety policy.",
    };
  }

  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), "pi-shell-benchmark-"));
  try {
    const workspace = join(root, WORKSPACE_DIRNAME);
    const verifier = join(root, VERIFIER_DIRNAME);
    await mkdir(join(workspace, "home"), { recursive: true });
    await mkdir(join(workspace, "tmp"), { recursive: true });
    await mkdir(verifier, { recursive: true });
    const candidatePath = join(workspace, "candidate.sh");
    const setupPath = join(workspace, "setup.sh");
    const verifyPath = join(verifier, "verify.sh");
    await writeFile(candidatePath, script, "utf8");
    await writeFile(setupPath, fixture.setup, "utf8");
    await writeFile(verifyPath, fixture.verify, "utf8");
    await chmod(candidatePath, 0o700);
    await chmod(setupPath, 0o700);
    await chmod(verifyPath, 0o700);
    const env = baseEnvironment(workspace, fixture, backend);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const setup = await runStage(backend, workspace, verifier, { hostPath: setupPath, sandboxPath: `${WORKSPACE_MOUNT}/setup.sh` }, env, timeoutMs, maxOutputBytes, runner);
    if (setup.status !== "exited" || setup.code !== 0) {
      return {
        status: setup.status === "timed-out" ? "timed-out" : "failed",
        syntax: "not-run",
        verification: "not-run",
        exitCode: setup.code,
        stdout: setup.stdout,
        stderr: setup.stderr,
        durationMs: Date.now() - started,
        findings,
        error: setup.error ?? "Fixture setup failed.",
      };
    }

    const syntax = backend === "host-temp"
      ? await runner("bash", ["-n", candidatePath], workspace, env, timeoutMs, maxOutputBytes)
      : await runner("bwrap", bwrapArgs(workspace, verifier, "bash", ["-n", `${WORKSPACE_MOUNT}/candidate.sh`]), workspace, env, timeoutMs, maxOutputBytes);
    if (syntax.status !== "exited" || syntax.code !== 0) {
      return {
        status: syntax.status === "timed-out" ? "timed-out" : "failed",
        syntax: "failed",
        verification: "not-run",
        exitCode: syntax.code,
        stdout: syntax.stdout,
        stderr: syntax.stderr,
        durationMs: Date.now() - started,
        findings,
        error: syntax.error ?? "Candidate failed bash -n.",
      };
    }

    const execution = await runStage(backend, workspace, verifier, { hostPath: candidatePath, sandboxPath: `${WORKSPACE_MOUNT}/candidate.sh` }, env, timeoutMs, maxOutputBytes, runner, fixture.arguments ?? []);
    if (execution.status !== "exited") {
      return {
        status: "timed-out",
        syntax: "passed",
        verification: "not-run",
        exitCode: execution.code,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: Date.now() - started,
        findings,
        error: execution.error,
      };
    }
    const expectedExitCode = fixture.expectedExitCode ?? 0;
    if (execution.code !== expectedExitCode) {
      return {
        status: "failed",
        syntax: "passed",
        verification: "not-run",
        exitCode: execution.code,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: Date.now() - started,
        findings,
        error: `Expected exit code ${expectedExitCode}, got ${execution.code}.`,
      };
    }

    const verify = await runStage(backend, workspace, verifier, { hostPath: verifyPath, sandboxPath: `${VERIFIER_MOUNT}/verify.sh` }, env, timeoutMs, maxOutputBytes, runner);
    const passed = verify.status === "exited" && verify.code === 0;
    return {
      status: passed ? "passed" : verify.status === "timed-out" ? "timed-out" : "failed",
      syntax: "passed",
      verification: passed ? "passed" : "failed",
      exitCode: execution.code,
      stdout: `${execution.stdout}${verify.stdout}`,
      stderr: `${execution.stderr}${verify.stderr}`,
      durationMs: Date.now() - started,
      findings,
      error: passed ? undefined : verify.error ?? "Fixture verification failed.",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
