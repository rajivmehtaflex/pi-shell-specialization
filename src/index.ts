import { BENCHMARK_CASES, validateBenchmarkCases } from "./cases.ts";
import { registerDiagnosticTools, type DiagnosticToolOptions } from "./diagnostic-tools.ts";
import { exportPublicQuestions } from "./question-export.ts";
import { CheckpointCommitter } from "./orchestrator/checkpoint-commit.ts";
import { registerOrchestrationTools } from "./orchestrator/orchestration-tools.ts";
import { HfGitSync } from "./orchestrator/git-sync.ts";
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

export interface OrchestrationWiring {
  root: string;
  mode: ExecutionMode;
  handlers: Map<string, PhaseHandler>;
  remote?: RemoteExecutor;
  checkpoint?: OrchestratorCheckpoint;
}

export function resolveExecutionMode(explicit?: ExecutionMode): ExecutionMode {
  return explicit ?? (process.env.WORKFLOW_MODE === "live" ? "live" : "dry-run");
}

/**
 * Mode-correct orchestration wiring (T6.1):
 * - live mode wires the configured SSH executor, its command handlers, and a
 *   real git-backed checkpoint (HfGitSync + CheckpointCommitter);
 * - dry-run mode wires neither an SSH executor nor SSH-backed handlers and
 *   leaves the checkpoint unset so the orchestrator falls back to its
 *   in-memory simulation checkpoint; a live executor can therefore never be
 *   reached, even accidentally, from dry-run.
 */
export function buildOrchestrationWiring(options: ShellSpecializationOptions = {}): OrchestrationWiring {
  const root = options.orchestrationRoot ?? process.env.PI_SPECIALIZATION_ROOT ?? process.cwd();
  const mode = resolveExecutionMode(options.executionMode);
  const remote = mode === "live" ? options.remoteExecutor ?? createConfiguredSshExecutor() : options.remoteExecutor;
  const handlers = options.handlers ?? (remote ? createCommandHandlers(loadPhaseCommands(root), remote) : new Map());
  let checkpoint = options.checkpoint;
  if (!checkpoint && mode === "live") {
    const committer = new CheckpointCommitter(new HfGitSync({ root }));
    checkpoint = async (label, phase, paths) => (await committer.checkpoint(label, phase, paths)).commit;
  }
  return { root, mode, handlers, remote, checkpoint };
}

export function registerShellSpecialization(pi: { registerTool(tool: any): void; on?: (event: string, handler: (event: unknown, ctx: any) => Promise<void> | void) => void }, options: ShellSpecializationOptions = {}): void {
  pi.registerTool({
    name: "shell_benchmark_cases",
    label: "Shell Benchmark Cases",
    description: "List sanitized model-facing questions from the 60-case Bash specialization diagnostic benchmark. Returns prompts and metadata only; fixtures, verifiers, and expected exit codes are never exposed, and execution requires the separate sandboxed runner.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", description: "Optional exact category filter" },
      },
    },
    async execute(_toolCallId: string, params: { category?: string }) {
      const questions = exportPublicQuestions().filter((question) => !params.category || question.category === params.category);
      return {
        content: [{ type: "text", text: JSON.stringify({ valid: validateBenchmarkCases(BENCHMARK_CASES).length === 0, questions }, null, 2) }],
        details: { count: questions.length },
      };
    },
  });
  registerDiagnosticTools(pi, options);

  const wiring = buildOrchestrationWiring(options);
  const orchestrator = new PhaseOrchestrator({
    root: wiring.root,
    mode: wiring.mode,
    handlers: wiring.handlers,
    remote: wiring.remote,
    checkpoint: wiring.checkpoint,
  });
  registerOrchestrationTools(pi, { orchestrator });
  registerPhaseDashboard(pi, orchestrator);
}

export default registerShellSpecialization;
