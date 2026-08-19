import { BENCHMARK_CASES, validateBenchmarkCases } from "./cases.ts";
import { registerDiagnosticTools, type DiagnosticToolOptions } from "./diagnostic-tools.ts";

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

export function registerShellSpecialization(pi: { registerTool(tool: any): void }, options?: DiagnosticToolOptions): void {
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
}

export default registerShellSpecialization;
