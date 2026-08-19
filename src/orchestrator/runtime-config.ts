import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SshRemoteExecutor } from "./ssh-executor.ts";
import type { PhaseHandler } from "./orchestrator.ts";
import type { RemoteExecutor } from "./remote-executor.ts";

export interface PhaseCommand {
  command: string;
  gpu: string;
  timeoutSeconds: number;
  estimatedCostUsd: number;
  estimatedGpuSeconds?: number;
}

function validateCommand(id: string, value: unknown): PhaseCommand {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`invalid phase command: ${id}`);
  const item = value as Record<string, unknown>;
  if (typeof item.command !== "string" || !item.command.trim()) throw new Error(`phase command missing command: ${id}`);
  if (typeof item.gpu !== "string" || !item.gpu.trim()) throw new Error(`phase command missing gpu: ${id}`);
  if (typeof item.timeoutSeconds !== "number" || item.timeoutSeconds < 1) throw new Error(`phase command invalid timeout: ${id}`);
  if (typeof item.estimatedCostUsd !== "number" || item.estimatedCostUsd < 0) throw new Error(`phase command invalid cost: ${id}`);
  return {
    command: item.command,
    gpu: item.gpu,
    timeoutSeconds: item.timeoutSeconds,
    estimatedCostUsd: item.estimatedCostUsd,
    estimatedGpuSeconds: typeof item.estimatedGpuSeconds === "number" ? item.estimatedGpuSeconds : undefined,
  };
}

export function loadPhaseCommands(root: string): Map<string, PhaseCommand> {
  const configuredPath = process.env.PI_PHASE_COMMANDS_FILE ?? join(root, "state", "phase-commands.json");
  if (!existsSync(configuredPath)) return new Map();
  const parsed = JSON.parse(readFileSync(configuredPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("phase-commands.json must be an object");
  const commands = new Map<string, PhaseCommand>();
  for (const [id, value] of Object.entries(parsed)) commands.set(id, validateCommand(id, value));
  return commands;
}

export function createCommandHandlers(commands: Map<string, PhaseCommand>, executor: RemoteExecutor): Map<string, PhaseHandler> {
  const handlers = new Map<string, PhaseHandler>();
  for (const [id, command] of commands) {
    handlers.set(id, {
      async run() {
        const job = await executor.launch({ phase: id, ...command, simulation: false });
        return { status: "working", job, nextAction: "poll SSH job" };
      },
    });
  }
  return handlers;
}

export function createConfiguredSshExecutor(): SshRemoteExecutor | undefined {
  const host = process.env.PI_SSH_HOST;
  const user = process.env.PI_SSH_USER;
  const remoteRoot = process.env.PI_SSH_REMOTE_ROOT;
  if (!host || !user || !remoteRoot) return undefined;
  const port = process.env.PI_SSH_PORT ? Number(process.env.PI_SSH_PORT) : 22;
  return new SshRemoteExecutor({ host, user, remoteRoot, port, identityFile: process.env.PI_SSH_IDENTITY_FILE });
}
