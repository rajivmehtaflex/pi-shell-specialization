import type { PhaseLedger, PhaseRecord, PhaseStatus } from "../orchestrator/phase-types.ts";
import type { PhaseOrchestrator } from "../orchestrator/orchestrator.ts";

const STATUS_GLYPHS: Record<PhaseStatus, string> = {
  pending: "·",
  working: "▶",
  done: "✓",
  failed: "✗",
  blocked: "⊘",
  interrupted: "↻",
};

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function cell(value: string, width: number): string {
  return truncate(value, width).padEnd(width, " ");
}

function cursor(phase: PhaseRecord): string {
  if (phase.inputCursor === undefined && phase.totalInputs === undefined) return "-";
  return `${phase.inputCursor ?? 0}/${phase.totalInputs ?? "?"}`;
}

function cost(phase: PhaseRecord): string {
  const value = phase.actualCostUsd ?? phase.estimatedCostUsd;
  return value === undefined ? "-" : `$${value.toFixed(2)}`;
}

export function renderPhaseDashboard(ledger: PhaseLedger, width = 120): string[] {
  const safeWidth = Math.max(40, width);
  const lines: string[] = [];
  lines.push(truncate(`PI SHELL SPECIALIZATION  |  mode=${ledger.mode}  |  dialect=${ledger.targetDialect}`, safeWidth));
  lines.push(truncate(`remote=${ledger.remote}  |  branch=${ledger.branch}  |  updated=${ledger.updatedAt}`, safeWidth));
  lines.push("");
  const detailWidth = Math.max(10, safeWidth - 6 - 12 - 12 - 18 - 7 - 8 - 8 - 7);
  const header = `${cell("ID", 6)} ${cell("STATUS", 12)} ${cell("CURSOR", 12)} ${cell("JOB", 18)} ${cell("REQ", 7)} ${cell("GPU", 8)} ${cell("COST", 8)} ${cell("PHASE / NEXT ACTION", detailWidth)}`;
  lines.push(truncate(header, safeWidth));
  lines.push(truncate("─".repeat(Math.min(safeWidth, header.length)), safeWidth));
  for (const phase of ledger.phases) {
    const label = `${phase.name}${phase.nextAction ? ` → ${phase.nextAction}` : ""}`;
    const row = `${cell(phase.id, 6)} ${cell(`${STATUS_GLYPHS[phase.status]} ${phase.status}`, 12)} ${cell(cursor(phase), 12)} ${cell(phase.jobId ?? "-", 18)} ${cell(phase.requiredGpuCount === 0 ? "-" : String(phase.requiredGpuCount), 7)} ${cell(phase.gpuSeconds === undefined ? "-" : String(phase.gpuSeconds), 8)} ${cell(cost(phase), 8)} ${truncate(label, detailWidth)}`;
    lines.push(truncate(row, safeWidth));
  }
  lines.push("");
  const working = ledger.phases.filter((phase) => phase.status === "working").length;
  const done = ledger.phases.filter((phase) => phase.status === "done").length;
  const blocked = ledger.phases.filter((phase) => phase.status === "blocked" || phase.status === "failed" || phase.status === "interrupted").length;
  lines.push(truncate(`progress=${done}/${ledger.phases.length} done  working=${working}  attention=${blocked}  recovery=state/phase-ledger.json`, safeWidth));
  return lines;
}

export interface PhaseDashboardPi {
  on?(event: string, handler: (event: unknown, ctx: any) => Promise<void> | void): void;
}

export function registerPhaseDashboard(pi: PhaseDashboardPi, orchestrator: PhaseOrchestrator): void {
  let activeContext: any = null;
  let ledger: PhaseLedger | undefined;

  const update = async (context: any): Promise<void> => {
    activeContext = context;
    ledger = await orchestrator.status();
    if (!context?.ui?.setWidget) return;
    context.ui.setWidget("shell-specialization-dashboard", (_tui: unknown, _theme: unknown) => ({
      dispose: () => {},
      invalidate: () => {},
      render: (width: number) => renderPhaseDashboard(ledger!, width),
    }));
  };

  pi.on?.("session_start", async (_event, context) => update(context));
  pi.on?.("tool_result", async (_event, context) => update(context));
  pi.on?.("tool_call", async (_event, context) => { activeContext = context; });

  void activeContext;
}
