import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  chat,
  embed,
  appendPromptLog,
  OllamaError,
  OllamaUnavailableError,
  OllamaServerError,
  OllamaTimeoutError,
  OllamaModelNotFoundError,
  OllamaJsonParseError,
  OllamaContextOverflowError,
  OllamaInvariantError,
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
    jsonResponse({ message: { role: "assistant", content: "hello back" }, prompt_eval_count: 3, eval_count: 4 });
  const result = await chat({ user: "hi" });
  assert.equal(result, "hello back");
  const log = await readFile(logPath, "utf8");
  assert.match(log, /# Prompt Log/);
  assert.match(log, /- ok: true/);
  assert.match(log, /- response: hello back/);
});

test("chat json mode parses object response", async () => {
  global.fetch = async () => jsonResponse({ message: { content: '{"a":1}' } });
  const result = await chat({ user: "give me json", json: true });
  assert.deepEqual(result, { a: 1 });
});

test("OllamaJsonParseError on invalid JSON, no internal retry, logs ok=false", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return jsonResponse({ message: { content: "not json {" } });
  };
  await assert.rejects(
    () => chat({ user: "x", json: true }),
    (err) => {
      assert.ok(err instanceof OllamaJsonParseError);
      assert.ok(err instanceof OllamaError);
      assert.equal(err.model, "gemma4:26b");
      assert.equal(err.responseHead, "not json {");
      assert.ok(err.cause);
      return true;
    },
  );
  assert.equal(calls, 1, "must not retry on JSON parse failure");
  const log = await readFile(logPath, "utf8");
  assert.match(log, /errorClass: OllamaJsonParseError/);
  assert.match(log, /- ok: false/);
});

test("OllamaInvariantError on empty content", async () => {
  global.fetch = async () => jsonResponse({ message: { content: "" } });
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => err instanceof OllamaInvariantError,
  );
});

test("OllamaInvariantError on missing message field", async () => {
  global.fetch = async () => jsonResponse({});
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => err instanceof OllamaInvariantError,
  );
});

test("OllamaUnavailableError on fetch network failure, retries once", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  };
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => {
      assert.ok(err instanceof OllamaUnavailableError);
      assert.equal(err.attempt, 2);
      assert.ok(err.cause);
      return true;
    },
  );
  assert.equal(calls, 2, "should retry once on network failure");
});

test("OllamaServerError on 500, retries once", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return textResponse("kaboom", 500);
  };
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => {
      assert.ok(err instanceof OllamaServerError);
      assert.equal(err.responseHead, "kaboom");
      return true;
    },
  );
  assert.equal(calls, 2, "should retry once on 5xx");
});

test("OllamaTimeoutError on AbortError, does NOT retry", async () => {
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
      assert.ok(err instanceof OllamaTimeoutError);
      assert.equal(err.model, "embeddinggemma:300m");
      assert.ok(err.cause);
      return true;
    },
  );
  assert.equal(calls, 1, "timeout must not retry");
});

test("OllamaModelNotFoundError on 404 with pull hint", async () => {
  global.fetch = async () => textResponse("model 'gemma4:26b' not found, try pulling it", 404);
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => {
      assert.ok(err instanceof OllamaModelNotFoundError);
      assert.match(err.message, /ollama pull gemma4:26b/);
      return true;
    },
  );
});

test("OllamaContextOverflowError on context-length error body", async () => {
  global.fetch = async () => textResponse("input exceeds context length", 400);
  await assert.rejects(
    () => chat({ user: "x" }),
    (err) => err instanceof OllamaContextOverflowError,
  );
});

test("embed happy path returns 768-length Float32Array for single input", async () => {
  const vec = Array.from({ length: 768 }, (_v, i) => i / 768);
  global.fetch = async () => jsonResponse({ model: "embeddinggemma:300m", embeddings: [vec] });
  const result = await embed("hello");
  assert.ok(result instanceof Float32Array);
  assert.equal(result.length, 768);
  assert.equal(result[0], 0);
});

test("embed batch returns array of Float32Array", async () => {
  global.fetch = async () =>
    jsonResponse({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
  const result = await embed(["a", "b"]);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.ok(result[0] instanceof Float32Array);
});

test("embed throws OllamaInvariantError on missing embeddings", async () => {
  global.fetch = async () => jsonResponse({});
  await assert.rejects(
    () => embed("x"),
    (err) => err instanceof OllamaInvariantError,
  );
});

test("appendPromptLog creates file and writes failure entry", async () => {
  const err = new OllamaTimeoutError("timed out", { model: "gemma4:26b", durationMs: 100 });
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
  assert.match(log, /errorClass: OllamaTimeoutError/);
  assert.match(log, /- ok: false/);
  assert.match(log, /- durationMs: 100/);
});

test("prompt-log truncates long fields to 200 chars", async () => {
  global.fetch = async () => jsonResponse({ message: { content: "ok" } });
  const long = "x".repeat(500);
  await chat({ user: long });
  const log = await readFile(logPath, "utf8");
  const userLine = log.split("\n").find((l) => l.startsWith("- user:"));
  assert.ok(userLine.endsWith("…"));
  assert.ok(userLine.length <= "- user: ".length + 201);
});
