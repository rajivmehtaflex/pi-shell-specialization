import test from "node:test";
import assert from "node:assert/strict";
import { BENCHMARK_CASES } from "./cases.ts";
import { nextQuestion, recordResponse, startSession } from "./session.ts";

test("session returns questions in stable order and then completes", () => {
  let session = startSession("qwen3.5:9b", "raw", { id: "s-order", questionIds: ["bash-001", "bash-002"] });
  assert.equal(nextQuestion(session)?.id, "bash-001");
  session = recordResponse(session, "bash-001", "```bash\ntrue\n```", 1, "2026-08-19T00:00:00Z");
  assert.equal(nextQuestion(session)?.id, "bash-002");
  session = recordResponse(session, "bash-002", "```bash\ntrue\n```", 1, "2026-08-19T00:00:01Z");
  assert.equal(nextQuestion(session), null);
});

test("session supports repeated attempts for one question before advancing", () => {
  let session = startSession("qwen3.5:9b", "raw", { id: "s-attempts", questionIds: ["bash-001", "bash-002"], attemptsPerQuestion: 2 });
  session = recordResponse(session, "bash-001", "```bash\ntrue\n```", 1);
  assert.equal(nextQuestion(session)?.id, "bash-001");
  session = recordResponse(session, "bash-001", "```bash\nfalse\n```", 2);
  assert.equal(nextQuestion(session)?.id, "bash-002");
});

test("session rejects unknown, out-of-order, and duplicate responses", () => {
  let session = startSession("qwen3.5:9b", "raw", { id: "s-errors", questionIds: ["bash-001"] });
  assert.throws(() => recordResponse(session, "unknown", "x", 1), /unknown/i);
  assert.throws(() => recordResponse(session, "bash-002", "x", 1), /current|order/i);
  session = recordResponse(session, "bash-001", "x", 1);
  assert.throws(() => recordResponse(session, "bash-001", "x", 1), /duplicate|complete/i);
});

test("fresh sessions do not share mutable attempt state", () => {
  const first = startSession("m", "raw", { id: "s1", questionIds: [BENCHMARK_CASES[0].id] });
  const second = startSession("m", "raw", { id: "s2", questionIds: [BENCHMARK_CASES[0].id] });
  const updated = recordResponse(first, BENCHMARK_CASES[0].id, "answer", 1);
  assert.equal(first.attempts.length, 0);
  assert.equal(updated.attempts.length, 1);
  assert.equal(second.attempts.length, 0);
});
