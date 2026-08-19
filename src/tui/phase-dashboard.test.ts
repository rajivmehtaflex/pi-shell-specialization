import test from "node:test";
import assert from "node:assert/strict";
import { createInitialLedger, markPhaseWorking } from "../orchestrator/phase-ledger.ts";
import { renderPhaseDashboard } from "./phase-dashboard.ts";

test("phase dashboard renders all phases and durable columns", () => {
  let ledger = createInitialLedger({ mode: "live", now: "2026-08-19T00:00:00Z" });
  ledger = markPhaseWorking(ledger, "P0", { jobId: "ssh-P0-abc", totalInputs: 60, now: "2026-08-19T00:01:00Z" });
  const lines = renderPhaseDashboard(ledger, 140);
  const text = lines.join("\n");
  assert.match(text, /PI SHELL SPECIALIZATION/);
  assert.match(text, /STATUS/);
  assert.match(text, /CURSOR/);
  assert.match(text, /JOB/);
  assert.match(text, /REQ/);
  assert.match(text, /P0/);
  assert.match(text, /working/);
  assert.match(text, /ssh-P0-abc/);
  assert.match(text, /P2\.6b/);
});

test("phase dashboard truncates rows to the requested width", () => {
  const ledger = createInitialLedger({ mode: "dry-run" });
  const lines = renderPhaseDashboard(ledger, 60);
  assert.ok(lines.every((line) => line.length <= 60));
});
