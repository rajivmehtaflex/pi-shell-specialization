import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";

function record(caseId: string, passed = false) {
  return {
    session_id: "cli-session", model: "qwen3.5:9b", provider: "external", track: "raw",
    case_id: caseId, attempt: 1, response: "```bash\ntrue\n```",
    execution: { status: passed ? "passed" : "failed", syntax: "passed", verification: passed ? "passed" : "failed", exitCode: passed ? 0 : 1, stdout: "", stderr: "", durationMs: 1, findings: [], error: passed ? undefined : "fixture verification failed" },
    runner: { shell: "/bin/bash", shellVersion: "3.2", sandbox: "external-vm" },
  };
}

test("questions command exports 60 public questions without hidden fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-cli-questions-"));
  const out = join(root, "questions.json");
  assert.equal(await main(["questions", "--public", "--out", out]), 0);
  const questions = JSON.parse(await readFile(out, "utf8"));
  assert.equal(questions.length, 60);
  assert.equal("testFixture" in questions[0], false);
});

test("import-results and report commands are analysis-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-cli-results-"));
  const input = join(root, "external.jsonl");
  const imported = join(root, "imported.json");
  const report = join(root, "WEAKNESS-PROFILE.md");
  await writeFile(input, ["quote-001", "quote-002", "quote-003", "quote-004"].map((id) => JSON.stringify(record(id))).join("\n") + "\n", "utf8");
  assert.equal(await main(["import-results", "--input", input, "--out", imported]), 0);
  const importedData = JSON.parse(await readFile(imported, "utf8"));
  assert.equal(importedData.records.length, 4);
  assert.equal(await main(["report", "--input", imported, "--out", report]), 0);
  assert.match(await readFile(report, "utf8"), /Confirmed weaknesses/);
});

test("export-bundle creates public questions, private evaluator data, and schema docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-cli-bundle-"));
  const bundle = join(root, "bundle");
  assert.equal(await main(["export-bundle", "--out", bundle]), 0);
  await access(join(bundle, "questions", "shell-questions-60-public.md"));
  await access(join(bundle, "questions", "shell-questions-60.json"));
  await access(join(bundle, "questions", "shell-questions-60-private.json"));
  await access(join(bundle, "RESULT-SCHEMA.md"));
  assert.match(await readFile(join(bundle, "README.md"), "utf8"), /external|sandbox/i);
});
