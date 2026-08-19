import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { ExecutionResult, SandboxOptions, SafetyFinding, TestFixture } from "./types.ts";
import { scanShellSafety } from "./safety.ts";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

interface ProcessResult {
  status: "exited" | "timed-out" | "error";
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
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

function bwrapArgs(root: string, command: string, args: string[]): string[] {
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
    "--bind", root, "/sandbox",
    "--chdir", "/sandbox",
    "--setenv", "HOME", "/sandbox/home",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TEST_ROOT", "/sandbox",
    command,
    ...args,
  ];
}

async function runStage(
  backend: "host-temp" | "bwrap",
  root: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxOutputBytes: number,
  args: string[] = [],
): Promise<ProcessResult> {
  if (backend === "host-temp") {
    return runProcess("bash", [scriptPath, ...args], root, env, timeoutMs, maxOutputBytes);
  }
  return runProcess("bwrap", bwrapArgs(root, "bash", [`/sandbox/${scriptPath.slice(root.length + 1)}`, ...args]), root, env, timeoutMs, maxOutputBytes);
}

function baseEnvironment(root: string, fixture: TestFixture, backend: "host-temp" | "bwrap"): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: backend === "bwrap" ? "/sandbox/home" : join(root, "home"),
    LANG: "C",
    LC_ALL: "C",
    TEST_ROOT: backend === "bwrap" ? "/sandbox" : root,
    TMPDIR: backend === "bwrap" ? "/tmp" : join(root, "tmp"),
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
  const requested = options.backend ?? "auto";
  let backend: "host-temp" | "bwrap";
  if (requested === "host-temp") {
    if (!options.allowUnsafeHostSandbox) return unavailableResult("Host-temp execution requires allowUnsafeHostSandbox=true.");
    backend = "host-temp";
  } else {
    const detected = detectSandboxBackend();
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
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "tmp"), { recursive: true });
    const candidatePath = join(root, "candidate.sh");
    const setupPath = join(root, "setup.sh");
    const verifyPath = join(root, "verify.sh");
    await writeFile(candidatePath, script, "utf8");
    await writeFile(setupPath, fixture.setup, "utf8");
    await writeFile(verifyPath, fixture.verify, "utf8");
    await chmod(candidatePath, 0o700);
    await chmod(setupPath, 0o700);
    await chmod(verifyPath, 0o700);
    const env = baseEnvironment(root, fixture, backend);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    const setup = await runStage(backend, root, setupPath, env, timeoutMs, maxOutputBytes);
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
      ? await runProcess("bash", ["-n", candidatePath], root, env, timeoutMs, maxOutputBytes)
      : await runProcess("bwrap", bwrapArgs(root, "bash", ["-n", `/sandbox/${candidatePath.slice(root.length + 1)}`]), root, env, timeoutMs, maxOutputBytes);
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

    const execution = await runStage(backend, root, candidatePath, env, timeoutMs, maxOutputBytes, fixture.arguments ?? []);
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

    const verify = await runStage(backend, root, verifyPath, env, timeoutMs, maxOutputBytes);
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
