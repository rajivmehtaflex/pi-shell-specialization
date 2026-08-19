import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { runScriptInSandbox } from "./sandbox.ts";
import { parseScriptResponse } from "./parser.ts";
import { scoreCase } from "./scoring.ts";
import type { DiagnosticCase, SandboxOptions, Track, TrackCaseScore, ExecutionResult, CaseScore } from "./types.ts";
import type { ModelInvoker } from "./invoker.ts";

const execFile = promisify(execFileCallback);

export interface BenchmarkRunOptions {
  tracks: Track[];
  invokers: Partial<Record<Track, ModelInvoker>>;
  sandbox?: SandboxOptions;
}

export interface BenchmarkRunItem extends TrackCaseScore {
  response: string;
  execution: ExecutionResult;
}

export interface BenchmarkRun {
  results: BenchmarkRunItem[];
}

async function prepareToolWorkspace(item: DiagnosticCase): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-shell-benchmark-pi-"));
  await mkdir(join(root, "home"), { recursive: true });
  const setupPath = join(root, "fixture-setup.sh");
  await writeFile(setupPath, item.testFixture.setup, "utf8");
  await execFile("bash", [setupPath], {
    cwd: root,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: join(root, "home"),
      TEST_ROOT: root,
      TMPDIR: root,
      ...item.testFixture.environment,
    },
    timeout: item.timeoutMs,
    maxBuffer: 64 * 1024,
  });
  return root;
}

async function cleanupWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export async function runBenchmark(cases: DiagnosticCase[], options: BenchmarkRunOptions): Promise<BenchmarkRun> {
  const results: BenchmarkRunItem[] = [];
  for (const track of options.tracks) {
    const invoker = options.invokers[track];
    if (!invoker) throw new Error(`No model invoker configured for ${track}.`);
    for (const item of cases.filter((candidate) => candidate.tracks.includes(track))) {
      let workspace: string | undefined;
      try {
        workspace = track === "pi-tools" ? await prepareToolWorkspace(item) : process.cwd();
        const response = await invoker.invoke(item.prompt, workspace);
        const parsed = parseScriptResponse(response);
        const execution = await runScriptInSandbox(parsed.script ?? "exit 1", item.testFixture, options.sandbox);
        const score: CaseScore = scoreCase(item, response, execution);
        results.push({ caseId: item.id, category: item.category, track, response, execution, ...score });
      } catch (error) {
        const response = "";
        const execution: ExecutionResult = {
          status: "failed",
          syntax: "not-run",
          verification: "not-run",
          exitCode: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
          findings: [],
          error: String(error),
        };
        const score = scoreCase(item, response, execution);
        results.push({ caseId: item.id, category: item.category, track, response, execution, ...score });
      } finally {
        if (workspace && track === "pi-tools") await cleanupWorkspace(workspace);
      }
    }
  }
  return { results };
}
