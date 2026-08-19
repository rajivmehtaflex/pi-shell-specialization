import { spawn } from "node:child_process";
import type { Track } from "./types.ts";

export interface PiInvokerOptions {
  model: string;
  track: Track;
  piCommand?: string;
  timeoutMs?: number;
  sandboxed?: boolean;
}

export interface ModelInvoker {
  invoke(prompt: string, cwd: string): Promise<string>;
}

export function buildPiArgs(options: Pick<PiInvokerOptions, "model" | "track">): string[] {
  const args = ["--mode", "text", "--no-session", "--no-context-files", "--model", options.model];
  if (options.track === "raw") args.push("--no-tools");
  else args.push("--tools", "read,write,edit,bash");
  args.push("-p");
  return args;
}

export function assertPiToolSandbox(input: { track: Track; sandboxed: boolean }): void {
  if (input.track === "pi-tools" && !input.sandboxed) {
    throw new Error("Pi tool-enabled evaluation requires an external sandbox declaration.");
  }
}

export class PiInvoker implements ModelInvoker {
  private readonly options: Required<Pick<PiInvokerOptions, "model" | "track" | "timeoutMs">> & { piCommand: string };

  constructor(options: PiInvokerOptions) {
    assertPiToolSandbox({ track: options.track, sandboxed: options.sandboxed ?? false });
    this.options = {
      model: options.model,
      track: options.track,
      timeoutMs: options.timeoutMs ?? 120_000,
      piCommand: options.piCommand ?? "pi",
    };
  }

  invoke(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.piCommand, [...buildPiArgs(this.options), prompt], {
        cwd,
        env: {
          ...process.env,
          PI_SHELL_BENCHMARK_TRACK: this.options.track,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error(`Pi invocation exceeded ${this.options.timeoutMs}ms.`));
        }
      }, this.options.timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Pi exited with code ${code}: ${(stderr || stdout).trim()}`));
      });
    });
  }
}
