import test from "node:test";
import assert from "node:assert/strict";
import { buildPiArgs, assertPiToolSandbox } from "./invoker.ts";

test("raw Pi invocation disables tools", () => {
  assert.deepEqual(buildPiArgs({ model: "qwen3.5:9b", track: "raw" }), [
    "--mode", "text", "--no-session", "--no-context-files", "--model", "qwen3.5:9b", "--no-tools", "-p",
  ]);
});

test("Pi tool invocation allowlists only coding tools", () => {
  assert.deepEqual(buildPiArgs({ model: "qwen3.5:9b", track: "pi-tools" }), [
    "--mode", "text", "--no-session", "--no-context-files", "--model", "qwen3.5:9b", "--tools", "read,write,edit,bash", "-p",
  ]);
});

test("tool-enabled Pi execution requires an external sandbox declaration", () => {
  assert.throws(() => assertPiToolSandbox({ track: "pi-tools", sandboxed: false }), /external sandbox/i);
  assert.doesNotThrow(() => assertPiToolSandbox({ track: "pi-tools", sandboxed: true }));
  assert.doesNotThrow(() => assertPiToolSandbox({ track: "raw", sandboxed: false }));
});
