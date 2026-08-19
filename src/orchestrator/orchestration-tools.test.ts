import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { PhaseOrchestrator } from "./orchestrator.ts";
import { registerOrchestrationTools, type OrchestrationTool } from "./orchestration-tools.ts";

test("orchestration tools expose status, phase execution, resume, cancel, and dashboard", async () => {
  const root = await mkdtemp(join("/tmp", "shell-tools-test-"));
  const tools = new Map<string, OrchestrationTool>();
  const orchestrator = new PhaseOrchestrator({
    root,
    mode: "dry-run",
    handlers: new Map([["P0", { async run() { return { status: "done", artifacts: [], artifactHashes: {}, nextAction: "next" }; } }]]),
    checkpoint: async () => "dry-run-commit",
  });
  registerOrchestrationTools({ registerTool(tool) { tools.set(tool.name, tool); } }, { orchestrator });
  for (const name of ["shell_specialization_status", "shell_specialization_run_next", "shell_specialization_run_phase", "shell_specialization_resume", "shell_specialization_cancel", "shell_specialization_dashboard", "shell_specialization_artifacts"]) {
    assert.ok(tools.has(name), name);
  }
  const status = await tools.get("shell_specialization_status")!.execute("1", {});
  assert.match(status.content[0].text, /P0/);
  const blocked = await tools.get("shell_specialization_run_next")!.execute("2", {});
  assert.match(blocked.content[0].text, /blocked|P0|done/i);
  const dashboard = await tools.get("shell_specialization_dashboard")!.execute("3", { width: 100 });
  assert.match(dashboard.content[0].text, /PI SHELL SPECIALIZATION/);
});
