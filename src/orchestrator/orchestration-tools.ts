import { renderPhaseDashboard } from "../tui/phase-dashboard.ts";
import type { PhaseOrchestrator } from "./orchestrator.ts";

export interface OrchestrationTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(toolCallId: string, params: Record<string, any>): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
}

export interface OrchestrationToolRegistrar {
  registerTool(tool: OrchestrationTool): void;
}

export interface OrchestrationToolOptions {
  orchestrator: PhaseOrchestrator;
}

function result(value: unknown, details?: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details };
}

export function registerOrchestrationTools(pi: OrchestrationToolRegistrar, options: OrchestrationToolOptions): void {
  const { orchestrator } = options;
  pi.registerTool({
    name: "shell_specialization_status",
    label: "Shell Specialization Status",
    description: "Read the durable Pi shell-specialization phase ledger without starting a job.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const ledger = await orchestrator.status();
      return result(ledger, { mode: ledger.mode });
    },
  });

  pi.registerTool({
    name: "shell_specialization_run_next",
    label: "Run Next Specialization Phase",
    description: "Run the next dependency-ready phase through the Pi orchestrator.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const outcome = await orchestrator.runNext();
      return result(outcome, { kind: outcome.kind });
    },
  });

  pi.registerTool({
    name: "shell_specialization_run_phase",
    label: "Run Specialization Phase",
    description: "Run one named phase after checking its dependencies and checkpointing its state.",
    parameters: {
      type: "object",
      required: ["phase"],
      properties: { phase: { type: "string", description: "Phase ID, for example P0 or P2.6" } },
    },
    async execute(_toolCallId, params) {
      const outcome = await orchestrator.runPhase(String(params.phase));
      return result(outcome, { kind: outcome.kind, phase: params.phase });
    },
  });

  pi.registerTool({
    name: "shell_specialization_resume",
    label: "Resume Shell Specialization",
    description: "Recover stale phases, poll saved SSH jobs, and persist the resumable ledger.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const ledger = await orchestrator.resume();
      return result(ledger, { action: "resume" });
    },
  });

  pi.registerTool({
    name: "shell_specialization_cancel",
    label: "Cancel Specialization Job",
    description: "Cancel the saved remote SSH job for a phase and mark it interrupted.",
    parameters: {
      type: "object",
      required: ["phase"],
      properties: { phase: { type: "string" } },
    },
    async execute(_toolCallId, params) {
      await orchestrator.cancel(String(params.phase));
      return result({ phase: params.phase, status: "interrupted" });
    },
  });

  pi.registerTool({
    name: "shell_specialization_dashboard",
    label: "Shell Specialization Dashboard",
    description: "Render the phase ledger as a compact Pi terminal table.",
    parameters: {
      type: "object",
      properties: { width: { type: "integer", minimum: 40, maximum: 240 } },
    },
    async execute(_toolCallId, params) {
      const ledger = await orchestrator.status();
      return result(renderPhaseDashboard(ledger, Number(params.width ?? 120)).join("\n"), { mode: ledger.mode });
    },
  });

  pi.registerTool({
    name: "shell_specialization_artifacts",
    label: "Specialization Artifacts",
    description: "List durable artifact paths and hashes recorded by the phase ledger.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const ledger = await orchestrator.status();
      const artifacts = ledger.phases.flatMap((phase) => phase.artifacts.map((path) => ({ phase: phase.id, path, sha256: phase.artifactHashes[path] })));
      return result({ artifacts }, { count: artifacts.length });
    },
  });
}
