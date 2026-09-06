import test from "node:test";
import assert from "node:assert/strict";
import {
  bwrapArgs,
  detectSandboxBackend,
  runScriptInSandbox,
  runScriptInSandboxWithOverrides,
  type ProcessResult,
  type SandboxProcessRunner,
} from "./sandbox.ts";
import type { ExecutionResult, TestFixture } from "./types.ts";

const passingFixture: TestFixture = {
  setup: "printf '%s\\n' 'hello world' > input.txt",
  verify: "test \"$(cat output.txt)\" = 'HELLO WORLD'",
};

test("runs a candidate in an explicitly opted-in temporary sandbox", async () => {
  const result = await runScriptInSandbox("tr '[:lower:]' '[:upper:]' < input.txt > output.txt", passingFixture, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
  });
  assert.equal(result.status, "passed");
  assert.equal(result.syntax, "passed");
});

test("blocks host execution unless explicitly opted in", async () => {
  const result = await runScriptInSandbox("printf unsafe", passingFixture, { backend: "host-temp" });
  assert.equal(result.status, "sandbox-unavailable");
});

test("reports syntax failures without running the verifier", async () => {
  const result = await runScriptInSandbox("if then", passingFixture, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.syntax, "failed");
  assert.equal(result.verification, "not-run");
});

test("times out runaway scripts", async () => {
  const result = await runScriptInSandbox("while :; do :; done", passingFixture, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
    timeoutMs: 50,
  });
  assert.equal(result.status, "timed-out");
});

test("passes fixture arguments to the candidate script", async () => {
  const result = await runScriptInSandbox("printf '%s' \"$1\" > output.txt", {
    setup: "true",
    verify: "test \"$(cat output.txt)\" = hello",
    arguments: ["hello"],
  }, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
  });
  assert.equal(result.status, "passed");
});

// --- bwrap simulation -------------------------------------------------------
// bwrap does not exist on the macOS dev host, so the bwrap backend is exercised
// by injecting a fake process runner (plus a fake backend detector) instead of
// requiring the real binary. The fake records every spawn so tests can pin the
// exact argv shape and environment, and returns scripted per-stage results.

type Stage = "setup" | "syntax" | "candidate" | "verify";

interface RecordedInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  stage: Stage;
}

function stageOf(args: string[]): Stage {
  if (args.includes("-n")) return "syntax";
  if (args.some((arg) => arg.endsWith("/setup.sh"))) return "setup";
  if (args.some((arg) => arg.endsWith("/candidate.sh"))) return "candidate";
  if (args.some((arg) => arg.endsWith("/verify.sh"))) return "verify";
  throw new Error(`Unrecognized stage invocation: ${args.join(" ")}`);
}

function exited(code = 0, stdout = "", stderr = ""): ProcessResult {
  return { status: "exited", code, stdout, stderr };
}

function fakeBwrap(
  respond: (stage: Stage, invocation: RecordedInvocation) => ProcessResult,
): { runner: SandboxProcessRunner; invocations: RecordedInvocation[] } {
  const invocations: RecordedInvocation[] = [];
  const runner: SandboxProcessRunner = async (command, args, cwd, env, timeoutMs, maxOutputBytes) => {
    const stage = stageOf(args);
    const invocation: RecordedInvocation = { command, args, cwd, env, timeoutMs, maxOutputBytes, stage };
    invocations.push(invocation);
    return respond(stage, invocation);
  };
  return { runner, invocations };
}

function bwrapBind(argv: string[], flag: "--bind" | "--ro-bind"): [hostPath: string, sandboxPath: string] {
  const index = argv.indexOf(flag);
  assert.notEqual(index, -1, `expected a ${flag} mount in argv: ${argv.join(" ")}`);
  return [argv[index + 1]!, argv[index + 2]!];
}

function roBindFor(argv: string[], sandboxPath: string): [hostPath: string, sandboxPath: string] {
  for (let index = 0; index < argv.length - 2; index += 1) {
    if (argv[index] === "--ro-bind" && argv[index + 2] === sandboxPath) {
      return [argv[index + 1]!, argv[index + 2]!];
    }
  }
  assert.fail(`no --ro-bind targeting ${sandboxPath} in: ${argv.join(" ")}`);
}

async function runWithFakeBwrap(
  script: string,
  fixture: TestFixture,
  respond: (stage: Stage, invocation: RecordedInvocation) => ProcessResult,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ result: ExecutionResult; invocations: RecordedInvocation[] }> {
  const { runner, invocations } = fakeBwrap(respond);
  const result = await runScriptInSandboxWithOverrides(script, fixture, { backend: "bwrap", ...options }, {
    detectBackend: () => "bwrap",
    runProcess: runner,
  });
  return { result, invocations };
}

test("bwrap argv mounts only the workspace read-write and the verifier read-only", async () => {
  // Pure argv shape with fixed paths.
  const argv = bwrapArgs("/host/root/workspace", "/host/root/verifier", "bash", ["/verifier/verify.sh"]);
  assert.equal(argv[0], "--die-with-parent");
  assert.ok(argv.includes("--unshare-all"));
  assert.ok(argv.includes("--new-session"));
  assert.equal(argv.filter((arg) => arg === "--bind").length, 1, "exactly one read-write bind allowed");
  assert.deepEqual(bwrapBind(argv, "--bind"), ["/host/root/workspace", "/sandbox"]);
  assert.deepEqual(roBindFor(argv, "/verifier"), ["/host/root/verifier", "/verifier"]);
  const chdir = argv.indexOf("--chdir");
  assert.equal(argv[chdir + 1], "/sandbox");
  assert.deepEqual(argv.slice(argv.indexOf("--setenv")), [
    "--setenv", "HOME", "/sandbox/home",
    "--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin",
    "--setenv", "TEST_ROOT", "/sandbox",
    "bash",
    "/verifier/verify.sh",
  ]);

  // Same shape asserted against the real pipeline via the fake runner.
  const { result, invocations } = await runWithFakeBwrap("exit 0", { setup: "true", verify: "true" }, () => exited(0), {
    timeoutMs: 1234,
    maxOutputBytes: 999,
  });
  assert.equal(result.status, "passed");
  assert.ok(invocations.length >= 4, "setup, syntax, candidate, and verify stages all ran");
  for (const invocation of invocations) {
    assert.equal(invocation.command, "bwrap");
    assert.ok(invocation.args.includes("--die-with-parent"), `die-with-parent missing: ${invocation.args.join(" ")}`);
    assert.ok(invocation.args.includes("--unshare-all"), `unshare-all missing: ${invocation.args.join(" ")}`);
    assert.equal(invocation.args.filter((arg) => arg === "--bind").length, 1, "only one rw bind allowed");
    const [workspaceHost, workspaceTarget] = bwrapBind(invocation.args, "--bind");
    assert.equal(workspaceTarget, "/sandbox");
    assert.ok(workspaceHost.endsWith("/workspace"), `rw bind must target the workspace dir, got ${workspaceHost}`);
    const [verifierHost] = roBindFor(invocation.args, "/verifier");
    assert.ok(!verifierHost.startsWith(`${workspaceHost}/`), "verifier dir must live outside the rw workspace");
    assert.equal(invocation.timeoutMs, 1234);
    assert.equal(invocation.maxOutputBytes, 999);
    assert.equal(invocation.env.HOME, "/sandbox/home");
    assert.equal(invocation.env.TEST_ROOT, "/sandbox");
    assert.equal(invocation.env.TMPDIR, "/tmp");
    assert.equal(invocation.env.PATH, "/usr/local/bin:/usr/bin:/bin");
    assert.equal(invocation.env.LANG, "C");
    assert.equal(invocation.env.LC_ALL, "C");
  }
  // The verifier stage runs the script from the read-only /verifier mount with cwd /sandbox.
  const verify = invocations.find((invocation) => invocation.stage === "verify")!;
  assert.equal(verify.args[verify.args.length - 1], "/verifier/verify.sh");
  const verifyChdir = verify.args.indexOf("--chdir");
  assert.equal(verify.args[verifyChdir + 1], "/sandbox");
});

test("stages execute in order: setup, bash -n, candidate, verify", async () => {
  const order: Stage[] = [];
  const { result } = await runWithFakeBwrap("exit 0", { setup: "true", verify: "true" }, (stage) => {
    order.push(stage);
    return exited(0);
  });
  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["setup", "syntax", "candidate", "verify"]);
});

test("candidate that overwrites the verifier path cannot forge verification", async () => {
  const fixture: TestFixture = {
    setup: "true",
    verify: "test \"$(cat output.txt)\" = right",
  };
  // The read-only /verifier mount turns the candidate's overwrite into a no-op,
  // so the fake simulates the kernel by keeping the verifier pristine: the
  // verify stage still runs the ORIGINAL fixture semantics (output must be
  // "right") from /verifier/verify.sh.
  const forged = await runWithFakeBwrap(
    "printf wrong > output.txt\nprintf 'exit 0' > /verifier/verify.sh",
    fixture,
    (stage) => (stage === "verify" ? exited(1) : exited(0)),
  );
  const forgedCandidate = forged.invocations.find((invocation) => invocation.stage === "candidate")!;
  const forgedVerify = forged.invocations.find((invocation) => invocation.stage === "verify")!;
  assert.equal(forgedCandidate.args[forgedCandidate.args.length - 1], "/sandbox/candidate.sh");
  assert.equal(forgedVerify.args[forgedVerify.args.length - 1], "/verifier/verify.sh");
  assert.equal(forged.result.status, "failed");
  assert.equal(forged.result.verification, "failed");

  // The same verifier passes an honest candidate: the outcome is decided by the
  // original fixture semantics, not by whatever the candidate wrote.
  const honest = await runWithFakeBwrap(
    "printf right > output.txt\nprintf 'exit 0' > /verifier/verify.sh",
    fixture,
    (stage) => (stage === "verify" ? exited(0) : exited(0)),
  );
  assert.equal(honest.result.status, "passed");
  assert.equal(honest.result.verification, "passed");
});

test("host-temp candidate clobbering verify.sh by relative name cannot forge verification", async () => {
  const fixture: TestFixture = {
    setup: "true",
    verify: "test \"$(cat output.txt)\" = right && grep -Fq VERIFIER-CANARY \"$TEST_ROOT/../verifier/verify.sh\"",
  };
  const result = await runScriptInSandbox(
    "printf wrong > output.txt\nprintf 'exit 0' > verify.sh",
    fixture,
    { backend: "host-temp", allowUnsafeHostSandbox: true },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.verification, "failed");

  const honest = await runScriptInSandbox("printf right > output.txt", fixture, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
  });
  assert.equal(honest.status, "passed");
  assert.equal(honest.verification, "passed");
});

test("auto backend fails closed when no secure sandbox is available", async () => {
  const result = await runScriptInSandboxWithOverrides("true", passingFixture, { backend: "auto" }, {
    detectBackend: () => "unavailable",
  });
  assert.equal(result.status, "sandbox-unavailable");
  assert.equal(result.syntax, "not-run");
  assert.equal(result.verification, "not-run");
});

test("hosts without bubblewrap fail closed instead of falling back to the host", async (t) => {
  if (detectSandboxBackend() !== "unavailable") {
    t.skip("bubblewrap is available on this host");
    return;
  }
  const auto = await runScriptInSandbox("true", passingFixture, { backend: "auto" });
  assert.equal(auto.status, "sandbox-unavailable");
  const explicit = await runScriptInSandbox("true", passingFixture, { backend: "bwrap" });
  assert.equal(explicit.status, "sandbox-unavailable");
});

test("candidate stage timeout is reported as timed-out without verification", async () => {
  const { result, invocations } = await runWithFakeBwrap(
    "while :; do :; done",
    { setup: "true", verify: "true" },
    (stage) => (stage === "candidate" ? { status: "timed-out", code: null, stdout: "", stderr: "" } : exited(0)),
  );
  assert.equal(result.status, "timed-out");
  assert.equal(result.syntax, "passed");
  assert.equal(result.verification, "not-run");
  assert.ok(!invocations.some((invocation) => invocation.stage === "verify"), "verifier must not run after a timeout");
});

test("output beyond maxOutputBytes is truncated", async () => {
  const result = await runScriptInSandbox("seq 1 10000", { setup: "true", verify: "true" }, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
    maxOutputBytes: 64,
  });
  assert.equal(result.status, "passed");
  assert.ok(Buffer.byteLength(result.stdout) <= 64, `stdout exceeds cap: ${Buffer.byteLength(result.stdout)} bytes`);
});

test("high-severity safety findings block execution before any stage runs", async () => {
  const result = await runScriptInSandbox("curl http://example.com > output.txt", { setup: "true", verify: "true" }, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.syntax, "not-run");
  assert.equal(result.verification, "not-run");
  assert.ok(result.findings.some((finding) => finding.severity === "high"));
});

test("expected exit code mismatch fails before the verifier runs", async () => {
  const result = await runScriptInSandbox("exit 0", { setup: "true", verify: "true", expectedExitCode: 3 }, {
    backend: "host-temp",
    allowUnsafeHostSandbox: true,
  });
  assert.equal(result.status, "failed");
  assert.equal(result.syntax, "passed");
  assert.equal(result.verification, "not-run");
  assert.match(result.error ?? "", /Expected exit code 3, got 0\./);
});
