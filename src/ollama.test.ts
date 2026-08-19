import test from "node:test";
import assert from "node:assert/strict";
import { OllamaInvoker } from "./ollama.ts";

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("ollama invoker posts a deterministic chat request and strips think blocks", async () => {
  let captured: { url: string; body: any } | undefined;
  const restore = mockFetch((_url, init) => {
    captured = { url: _url, body: JSON.parse(String(init.body)) };
    return new Response(
      JSON.stringify({ message: { content: "<think>plan</think>\nSure:\n```bash\necho ok\n```" } }),
      { status: 200 },
    );
  });
  try {
    const invoker = new OllamaInvoker({ model: "qwen3.5:9b" });
    const content = await invoker.invoke("hi", "/tmp");
    assert.equal(content, "Sure:\n```bash\necho ok\n```");
    assert.ok(captured);
    assert.equal(captured!.url, "http://localhost:11434/api/chat");
    assert.equal(captured!.body.model, "qwen3.5:9b");
    assert.equal(captured!.body.stream, false);
    assert.equal(captured!.body.think, false);
    assert.equal(captured!.body.options.temperature, 0);
    assert.equal(captured!.body.options.seed, 42);
    assert.equal(captured!.body.messages[0].role, "user");
  } finally {
    restore();
  }
});

test("ollama invoker surfaces HTTP errors", async () => {
  const restore = mockFetch(() => new Response("nope", { status: 500 }));
  try {
    const invoker = new OllamaInvoker({ model: "m" });
    await assert.rejects(() => invoker.invoke("hi", "/tmp"), /500/);
  } finally {
    restore();
  }
});

test("ollama invoker surfaces transport errors", async () => {
  const restore = mockFetch(() => {
    throw new Error("connection refused");
  });
  try {
    const invoker = new OllamaInvoker({ model: "m", timeoutMs: 500 });
    await assert.rejects(() => invoker.invoke("hi", "/tmp"), /connection refused|aborted|timeout/i);
  } finally {
    restore();
  }
});
