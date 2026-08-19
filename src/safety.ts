import type { SafetyFinding } from "./types.ts";

const RULES: Array<{ label: string; severity: SafetyFinding["severity"]; pattern: RegExp; message: string }> = [
  { label: "network-access", severity: "high", pattern: /\b(?:curl|wget|nc|ncat|ssh|scp|sftp|telnet)\b/, message: "Network-capable command is not allowed in the benchmark sandbox." },
  { label: "destructive-root", severity: "high", pattern: /\brm\s+(?:-[^\s]+\s+)*\/\s*(?:$|\n|[;&|])|>\s*\/\s*(?:$|\n|[;&|])/, message: "Destructive operation targets the filesystem root." },
  { label: "privileged-command", severity: "high", pattern: /\b(?:sudo|doas|su)\b/, message: "Privilege escalation command is not allowed." },
  { label: "namespace-escape", severity: "high", pattern: /\b(?:chroot|mount|umount|nsenter|unshare|mkfs|dd)\b/, message: "Namespace or raw-device operation is not allowed." },
];

export function scanShellSafety(script: string): SafetyFinding[] {
  return RULES.filter((rule) => rule.pattern.test(script)).map(({ label, severity, message }) => ({ label, severity, message }));
}
