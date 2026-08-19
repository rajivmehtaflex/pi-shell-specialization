import test from "node:test";
import assert from "node:assert/strict";
import { runScriptInSandbox } from "./sandbox.ts";
import type { TestFixture } from "./types.ts";

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
