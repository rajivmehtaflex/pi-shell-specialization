import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDiagnosticTools } from "./diagnostic-tools.ts";

function makeRecord(caseId: string, passed: boolean) {
  return {
    session_id: "report-session", model: "qwen3.5:9b", provider: "external", track: "raw",
    case_id: caseId, attempt: 1, response: "```bash\ntrue\n```",
    execution: { status: passed ? "passed" : "failed", syntax: "passed", verification: passed ? "passed" : "failed", exitCode: passed ? 0 : 1, stdout: "", stderr: "", durationMs: 1, findings: [], error: passed ? undefined : "fixture verification failed" },
    runner: { shell: "/bin/bash", shellVersion: "3.2", sandbox: "external-vm" },
  };
}

test("weakness report imports validated records and writes evidence profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-report-tool-"));
  const input = join(root, "external.jsonl");
  const output = join(root, "WEAKNESS-PROFILE.md");
  const records = ["quote-001", "quote-002", "quote-003", "quote-004"].map((id) => makeRecord(id, false));
  await writeFile(input, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  const tools = new Map<string, any>();
  registerDiagnosticTools({ registerTool: (tool) => tools.set(tool.name, tool) });
  const result = JSON.parse((await tools.get("shell_benchmark_weakness_report").execute("1", { input, out: output })).content[0].text);
  assert.equal(result.model, "qwen3.5:9b");
  assert.ok(result.weaknesses.length > 0);
  assert.match(await readFile(output, "utf8"), /Confirmed weaknesses/);
});
