import test from "node:test";
import assert from "node:assert/strict";
import { LlamaCppTeacherClient } from "./teacher-client.ts";

function installFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("llama.cpp client posts OpenAI-compatible chat completion", async () => {
  let body: any;
  const restore = installFetch((_url, init) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ id: "req-1", choices: [{ message: { content: "```bash\nprintf ok\n```" } }] }), { status: 200 });
  });
  try {
    const client = new LlamaCppTeacherClient({ baseUrl: "http://teacher.test/v1", model: "ridge27b", apiKey: "secret" });
    const result = await client.generate("write a script", { temperature: 0, seed: 42, maxTokens: 128 });
    assert.equal(result.text, "```bash\nprintf ok\n```");
    assert.equal(result.requestId, "req-1");
    assert.equal(body.model, "ridge27b");
    assert.equal(body.messages[0].content, "write a script");
    assert.equal(body.max_tokens, 128);
    assert.equal(body.seed, 42);
  } finally {
    restore();
  }
});

test("llama.cpp client retries bounded failures and then succeeds", async () => {
  let calls = 0;
  const restore = installFetch(() => {
    calls += 1;
    if (calls < 2) return new Response("temporary", { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  });
  try {
    const client = new LlamaCppTeacherClient({ baseUrl: "http://teacher.test/v1", model: "m", retryDelayMs: 0 });
    assert.equal((await client.generateWithRetries("p", { maxAttempts: 2 })).text, "ok");
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test("llama.cpp client never falls back to another provider", async () => {
  const restore = installFetch(() => new Response("bad", { status: 500 }));
  try {
    const client = new LlamaCppTeacherClient({ baseUrl: "http://teacher.test/v1", model: "m", retryDelayMs: 0 });
    await assert.rejects(() => client.generate("p"), /HTTP 500/);
  } finally {
    restore();
  }
});
