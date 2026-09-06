import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDiagnosticTools } from "./diagnostic-tools.ts";
import { registerShellSpecialization } from "./index.ts";

function registry() {
  const tools = new Map<string, any>();
  registerDiagnosticTools({ registerTool: (tool) => tools.set(tool.name, tool) }, { sessionsDir: "/tmp/pi-shell-benchmark-test-sessions", importedDir: "/tmp/pi-shell-benchmark-test-imported", now: () => "2026-08-19T00:00:00Z" });
  return tools;
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

test("question tool returns 60 sanitized questions", async () => {
  const tools = registry();
  const result = payload(await tools.get("shell_benchmark_question_list").execute("1", {}));
  assert.equal(result.count, 60);
  assert.equal("testFixture" in result.questions[0], false);
  assert.equal("verify" in result.questions[0], false);
});

test("Pi tools create, advance, and record a session without execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-tools-test-"));
  const tools = new Map<string, any>();
  registerDiagnosticTools({ registerTool: (tool) => tools.set(tool.name, tool) }, { sessionsDir: join(root, "sessions"), now: () => "2026-08-19T00:00:00Z" });
  const started = payload(await tools.get("shell_benchmark_start").execute("1", {
    model: "qwen3.5:9b", track: "raw", attempts: 1, session_id: "session-test",
  }));
  assert.equal(started.session.id, "session-test");
  const next = payload(await tools.get("shell_benchmark_next").execute("2", { session_id: "session-test" }));
  assert.equal(next.question.id, "bash-001");
  const recorded = payload(await tools.get("shell_benchmark_record_response").execute("3", {
    session_id: "session-test", case_id: "bash-001", attempt: 1, response: "```bash\ntrue\n```",
  }));
  assert.equal(recorded.accepted, true);
  assert.equal(recorded.next.id, "bash-002");
});

test("import tool validates JSONL and writes only accepted records", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-import-test-"));
  const input = join(root, "external.jsonl");
  const output = join(root, "imported.jsonl");
  const valid = {
    session_id: "s1", model: "qwen3.5:9b", provider: "external", track: "raw",
    case_id: "bash-001", attempt: 1, response: "```bash\ntrue\n```",
    execution: { status: "passed", syntax: "passed", verification: "passed", exitCode: 0, stdout: "", stderr: "", durationMs: 1, findings: [] },
    runner: { shell: "/bin/bash", shellVersion: "3.2", sandbox: "external-vm" },
  };
  await writeFile(input, `${JSON.stringify(valid)}\n${JSON.stringify({ ...valid, case_id: "missing" })}\n`, "utf8");
  const tools = new Map<string, any>();
  registerDiagnosticTools({ registerTool: (tool) => tools.set(tool.name, tool) }, { importedDir: join(root, "default-imported") });
  const result = payload(await tools.get("shell_benchmark_import_results").execute("4", { input, out: output }));
  assert.equal(result.accepted, 1);
  assert.equal(result.rejected, 1);
  assert.equal((await readFile(output, "utf8")).trim().split("\n").length, 1);
});

test("legacy benchmark cases tool returns only sanitized public questions", async () => {
  const tools = new Map<string, any>();
  registerShellSpecialization({ registerTool: (tool) => tools.set(tool.name, tool) });
  const tool = tools.get("shell_benchmark_cases");
  assert.ok(tool, "shell_benchmark_cases must stay registered");
  const result = payload(await tool.execute("1", {}));
  assert.equal(result.valid, true);
  assert.equal(result.questions.length, 60);
  const keys = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key);
        collect(entry);
      }
    }
  };
  collect(result);
  for (const banned of ["testFixture", "verify", "expectedExitCode", "failureLabels", "setup"]) {
    assert.equal(keys.has(banned), false, `payload must not expose key: ${banned}`);
  }
  assert.ok(keys.has("prompt") && keys.has("id") && keys.has("category"));
  const filtered = payload(await tool.execute("2", { category: "Security and command-injection resistance" }));
  assert.ok(filtered.questions.length > 0 && filtered.questions.length < 60);
  assert.ok(filtered.questions.every((question: any) => question.category === "Security and command-injection resistance"));
});
