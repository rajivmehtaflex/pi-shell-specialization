import type { ParsedScriptResponse } from "./types.ts";

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

export function parseScriptResponse(response: string): ParsedScriptResponse {
  const matches = [...response.matchAll(FENCE_RE)];
  if (matches.length === 0) {
    return response.trim().length === 0
      ? { format: "missing", error: "Model returned no content." }
      : { format: "plain", error: "Expected exactly one fenced Bash script." };
  }
  if (matches.length !== 1) {
    return { format: "ambiguous", error: "Model returned multiple fenced code blocks." };
  }
  const language = matches[0][1].trim().toLowerCase();
  const script = matches[0][2].trim();
  if (language === "bash" || language === "sh" || language === "shell") {
    return { format: "fenced-bash", script };
  }
  return { format: "fenced-other", script, error: `Unsupported code fence language: ${language || "unspecified"}` };
}
