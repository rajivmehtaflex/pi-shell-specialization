export interface TeacherGenerationOptions {
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface LlamaCppTeacherClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  retryDelayMs?: number;
  defaultTimeoutMs?: number;
}

export interface TeacherGenerationResult {
  text: string;
  requestId?: string;
}

export class LlamaCppTeacherClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly retryDelayMs: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: LlamaCppTeacherClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 180_000;
  }

  async generate(prompt: string, options: TeacherGenerationOptions = {}): Promise<TeacherGenerationResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0,
        seed: options.seed ?? 42,
        max_tokens: options.maxTokens ?? 2048,
        stream: false,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? this.defaultTimeoutMs),
    });
    if (!response.ok) throw new Error(`llama.cpp HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = await response.json() as { id?: string; choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("llama.cpp response has no assistant content");
    return { text, requestId: data.id };
  }

  async generateWithRetries(prompt: string, options: TeacherGenerationOptions = {}): Promise<TeacherGenerationResult> {
    const maxAttempts = options.maxAttempts ?? 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.generate(prompt, options);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts && this.retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
