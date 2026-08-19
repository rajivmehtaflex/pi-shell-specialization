import { BENCHMARK_CASES, validateBenchmarkCases } from "./cases.ts";
import { registerDiagnosticTools, type DiagnosticToolOptions } from "./diagnostic-tools.ts";
import { registerOrchestrationTools } from "./orchestrator/orchestration-tools.ts";
import { PhaseOrchestrator, type OrchestratorCheckpoint, type PhaseHandler } from "./orchestrator/orchestrator.ts";
import type { ExecutionMode } from "./orchestrator/phase-types.ts";
import type { RemoteExecutor } from "./orchestrator/remote-executor.ts";
import { createCommandHandlers, createConfiguredSshExecutor, loadPhaseCommands } from "./orchestrator/runtime-config.ts";
import { registerPhaseDashboard } from "./tui/phase-dashboard.ts";

export * from "./types.ts";
export * from "./cases.ts";
export * from "./parser.ts";
export * from "./safety.ts";
export * from "./sandbox.ts";
export * from "./scoring.ts";
export * from "./report.ts";
export * from "./invoker.ts";
export * from "./runner.ts";
export * from "./diagnostic-types.ts";
export * from "./question-export.ts";
export * from "./session.ts";
export * from "./diagnostic-tools.ts";
export * from "./insights.ts";
export * from "./orchestrator/artifact-manifest.ts";
export * from "./orchestrator/checkpoint-commit.ts";
export * from "./orchestrator/data-phase.ts";
export * from "./orchestrator/dry-run.ts";
export * from "./orchestrator/git-sync.ts";
export * from "./orchestrator/orchestration-tools.ts";
export * from "./orchestrator/orchestrator.ts";
export * from "./orchestrator/phase-ledger.ts";
export * from "./orchestrator/phase-types.ts";
export * from "./orchestrator/question-generator.ts";
export * from "./orchestrator/remote-executor.ts";
export * from "./orchestrator/runtime-config.ts";
export * from "./orchestrator/ssh-executor.ts";
export * from "./orchestrator/teacher-client.ts";
export * from "./tui/phase-dashboard.ts";

export interface ShellSpecializationOptions extends DiagnosticToolOptions {
  orchestrationRoot?: string;
  executionMode?: ExecutionMode;
  handlers?: Map<string, PhaseHandler>;
  remoteExecutor?: RemoteExecutor;
  checkpoint?: OrchestratorCheckpoint;
}

export function registerShellSpecialization(pi: { registerTool(tool: any): void; on?: (event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) => void }, options: ShellSpecializationOptions = {}): void {
  pi.registerTool({
    name: "shell_benchmark_cases",
    label: "Shell Benchmark Cases",
    description: "Inspect the 60-case Bash specialization diagnostic benchmark. This tool only returns prompts and metadata; execution requires the separate sandboxed runner.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional exact category filter" },
      },
    },
    async execute(_toolCallId: string, params: { category?: string }) {
      const cases = params.category ? BENCHMARK_CASES.filter((item) => item.category === params.category) : BENCHMARK_CASES;
      return {
        content: [{ type: "text", text: JSON.stringify({ valid: validateBenchmarkCases(BENCHMARK_CASES).length === 0, cases }, null, 2) }],
        details: { count: cases.length },
      };
    },
  });
  registerDiagnosticTools(pi, options);

  const root = options.orchestrationRoot ?? process.env.PI_SPECIALIZATION_ROOT ?? process.cwd();
  const mode: ExecutionMode = options.executionMode ?? (process.env.WORKFLOW_MODE === "live" ? "live" : "dry-run");
  const remoteExecutor = options.remoteExecutor ?? createConfiguredSshExecutor();
  const handlers = options.handlers ?? (remoteExecutor ? createCommandHandlers(loadPhaseCommands(root), remoteExecutor) : new Map());
  const orchestrator = new PhaseOrchestrator({
    root,
    mode,
    handlers,
    remote: remoteExecutor,
    checkpoint: options.checkpoint,
  });
  registerOrchestrationTools(pi, { orchestrator });
  registerPhaseDashboard(pi, orchestrator);
}

export default registerShellSpecialization;
