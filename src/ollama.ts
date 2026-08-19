import type { ModelInvoker } from "./invoker.ts";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

export interface OllamaInvokerOptions {
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  temperature?: number;
  seed?: number;
  numPredict?: number;
}

export interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
}

export class OllamaInvoker implements ModelInvoker {
  private readonly options: Required<OllamaInvokerOptions>;

  constructor(options: OllamaInvokerOptions) {
    this.options = {
      model: options.model,
      baseUrl: options.baseUrl ?? OLLAMA_URL,
      timeoutMs: options.timeoutMs ?? 300_000,
      temperature: options.temperature ?? 0,
      seed: options.seed ?? 42,
      numPredict: options.numPredict ?? 2048,
    };
  }

  async invoke(prompt: string, _cwd: string): Promise<string> {
    const response = await fetch(`${this.options.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        think: false,
        keep_alive: "30m",
        options: {
          temperature: this.options.temperature,
          seed: this.options.seed,
          num_predict: this.options.numPredict,
        },
      }),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    const data = (await response.json()) as OllamaChatResponse;
    if (data.error) throw new Error(`Ollama error: ${data.error}`);
    const content = data.message?.content ?? "";
    // Qwen thinking models may emit <think>…</think> blocks that can contain
    // stray fenced snippets; strip them so the single-fence parser stays exact.
    return content.replace(THINK_BLOCK, "").trim();
  }
}

export async function ollamaModelAvailable(baseUrl = OLLAMA_URL, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
