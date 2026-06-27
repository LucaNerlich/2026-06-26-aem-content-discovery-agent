import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chat,
  embed,
  appendPromptLog,
  getHost,
  llmFetch,
  LlmError,
  LlmUnavailableError,
  LlmServerError,
  LlmTimeoutError,
  LlmModelNotFoundError,
  LlmJsonParseError,
  LlmContextOverflowError,
  LlmInvariantError,
  truncateHead,
} from "../src/llm/index.js";

let originalFetch;
let tmpDir;
let logPath;

beforeEach(async () => {
  originalFetch = global.fetch;
  tmpDir = await mkdtemp(join(tmpdir(), "llm-test-"));
  logPath = join(tmpDir, "prompt-log.md");
  process.env.PROMPT_LOG_PATH = logPath;
});

afterEach(async () => {
  global.fetch = originalFetch;
  delete process.env.PROMPT_LOG_PATH;
  await rm(tmpDir, { recursive: true, force: true });
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body, status) {
  return new Response(body, { status });
}

test("truncateHead trims to 200 chars with ellipsis", () => {
  const long = "a".repeat(500);
  const head = truncateHead(long);
  assert.equal(head.length, 201);
  assert.ok(head.endsWith("…"));
  assert.equal(truncateHead(undefined), undefined);
  assert.equal(truncateHead(""), undefined);
});

test("chat happy path returns text and logs ok=true to prompt-log", async () => {
  global.fetch = async () =>
    jsonResponse({ choices: [{ message: { role: "assistant", content: "hello back" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
  const result = await chat({ user: "hi" });
  assert.equal(result, "hello back");
  const log = await readFile(logPath, "utf8");
  assert.match(log, /# Prompt Log/);
  assert.match(log, /- ok: true/);
  assert.match(log, /- response: hello back/);
});

test("chat json mode parses object response", async () => {
  global.fetch = async () => jsonResponse({ choices: [{ message: { content: '{"a":1}' } }] });
  const result = await chat({ user: "give me json", json: true });
  assert.deepEqual(result, { a: 1 });
});

test("LlmJsonParseError on invalid JSON, no internal retry, logs ok=false", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ choices: [{ message: { content: "not json {" } }] });
  };
  await assert.rejects(
    () => chat({ user: "x", json: true }),
    (err) => {
      assert.ok(err instanceof LlmJsonParseError);
      assert.ok(err instanceof LlmError);
      assert.equal(err.model, "google/gemma-4-e4b");
      assert.equal(err.responseHead, "not json {");
      assert.ok(err.cause);
      return true;
    },
  );
  assert.equal(calls, 1, "must not retry on JSON parse failure");
  const log = await readFile(logPath, "utf8");
  assert.match(log, /errorClass: LlmJsonParseError/);
  assert.match(log, /- ok: false/);
});

test("LlmInvariantError on empty content", async () => {
  global.fetch = async () => jsonResponse({ choices: [{ message: { content: "" } }] });
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => err instanceof LlmInvariantError,
  );
});

test("LlmInvariantError on missing choices field", async () => {
  global.fetch = async () => jsonResponse({});
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => err instanceof LlmInvariantError,
  );
});

test("LlmUnavailableError on fetch network failure, retries once", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => {
      assert.ok(err instanceof LlmUnavailableError);
      assert.equal(err.attempt, 2);
      assert.ok(err.cause);
      return true;
    },
  );
  assert.equal(calls, 2, "should retry once on network failure");
});

test("LlmServerError on 500, retries once", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return textResponse("kaboom", 500);
  };
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => {
      assert.ok(err instanceof LlmServerError);
      assert.equal(err.responseHead, "kaboom");
      return true;
    },
  );
  assert.equal(calls, 2, "should retry once on 5xx");
});

test("LlmTimeoutError on AbortError, does NOT retry", async () => {
  let calls = 0;
  global.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  process.env.LOG_LEVEL = "silent";
  await assert.rejects(
    () => embed("hello"),
    (err) => {
      assert.ok(err instanceof LlmTimeoutError);
      assert.equal(err.model, "embeddinggemma-300m");
      assert.ok(err.cause);
      return true;
    },
  );
  assert.equal(calls, 1, "timeout must not retry");
});

test("LlmModelNotFoundError on 404 with model hint", async () => {
  global.fetch = async () => textResponse("model 'google/gemma-4-e4b' not found", 404);
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => {
      assert.ok(err instanceof LlmModelNotFoundError);
      assert.match(err.message, /google\/gemma-4-e4b/);
      assert.match(err.message, /LM Studio/);
      return true;
    },
  );
});

test("LlmContextOverflowError on context-length error body", async () => {
  global.fetch = async () => textResponse("input exceeds context length", 400);
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => err instanceof LlmContextOverflowError,
  );
});

test("embed happy path returns Float32Array for single input", async () => {
  const vec = Array.from({ length: 768 }, (_v, i) => i / 768);
  global.fetch = async () => jsonResponse({ data: [{ object: "embedding", index: 0, embedding: vec }] });
  const result = await embed("hello");
  assert.ok(result instanceof Float32Array);
  assert.equal(result.length, 768);
  assert.equal(result[0], 0);
});

test("embed batch returns array of Float32Array", async () => {
  global.fetch = async () =>
    jsonResponse({ data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }] });
  const result = await embed(["a", "b"]);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.ok(result[0] instanceof Float32Array);
});

test("embed throws LlmInvariantError on missing data array", async () => {
  global.fetch = async () => jsonResponse({});
  await assert.rejects(
    () => embed("x"),
    (err) => err instanceof LlmInvariantError,
  );
});

test("appendPromptLog creates file and writes failure entry", async () => {
  const err = new LlmTimeoutError("timed out", { model: "gemma4:26b", durationMs: 100 });
  await appendPromptLog({
    model: "gemma4:26b",
    system: "sys",
    user: "u",
    error: err,
    ok: false,
    durationMs: 100,
  });
  const log = await readFile(logPath, "utf8");
  assert.match(log, /# Prompt Log/);
  assert.match(log, /errorClass: LlmTimeoutError/);
  assert.match(log, /- ok: false/);
  assert.match(log, /- durationMs: 100/);
});

test("prompt-log truncates long fields to 200 chars", async () => {
  global.fetch = async () => jsonResponse({ choices: [{ message: { content: "ok" } }] });
  const long = "x".repeat(500);
  await chat({ user: long });
  const log = await readFile(logPath, "utf8");
  const userLine = log.split("\n").find((l) => l.startsWith("- user:"));
  assert.ok(userLine.endsWith("…"));
  assert.ok(userLine.length <= "- user: ".length + 201);
});

test("chat forwards options.num_predict as top-level max_tokens", async () => {
  let captured;
  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: "ok" } }] });
  };
  await chat({ user: "hi", options: { num_predict: 1234 } });
  assert.equal(captured.max_tokens, 1234);
  assert.equal(captured.temperature, 1.0, "default temperature preserved");
  assert.equal(captured.options, undefined, "no nested options object in OpenAI-compat body");
});

test("think-stripper removes leading <think>...</think> block", async () => {
  global.fetch = async () =>
    jsonResponse({ choices: [{ message: { content: "<think>internal reasoning here</think>actual content" } }] });
  const result = await chat({ user: "hi" });
  assert.equal(result, "actual content");
});

test("truncated mid-think throws LlmInvariantError with diagnostic message", async () => {
  global.fetch = async () =>
    jsonResponse({ choices: [{ message: { content: "<think>partial reasoning never closed..." } }] });
  await assert.rejects(
    () => chat({ user: "hi" }),
    (err) => {
      assert.ok(err instanceof LlmInvariantError);
      assert.match(err.message, /truncated mid-think/);
      return true;
    },
  );
});

test("OpenAI-compat body omits response_format for json mode (LM Studio compat)", async () => {
  let captured;
  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return jsonResponse({ choices: [{ message: { content: '{"x":1}' } }] });
  };
  await chat({ user: "hi", json: true });
  assert.equal(captured.response_format, undefined, "response_format must not be set for LM Studio compat");
  assert.equal(captured.format, undefined, "legacy non-OpenAI format field must not be set");
});


test("getHost: returns LLM_HOST when set", () => {
  const oldLlm = process.env.LLM_HOST;
  try {
    process.env.LLM_HOST = "http://llm-host:9001";
    assert.equal(getHost(), "http://llm-host:9001");
  } finally {
    if (oldLlm === undefined) delete process.env.LLM_HOST; else process.env.LLM_HOST = oldLlm;
  }
});

test("getHost: returns DEFAULT_HOST when LLM_HOST unset", () => {
  const oldLlm = process.env.LLM_HOST;
  try {
    delete process.env.LLM_HOST;
    assert.equal(getHost(), "http://localhost:1234");
  } finally {
    if (oldLlm === undefined) delete process.env.LLM_HOST; else process.env.LLM_HOST = oldLlm;
  }
});
