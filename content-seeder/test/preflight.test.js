import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { preflightModels } from "../src/preflight.js";

let originalFetch;

beforeEach(() => {
  originalFetch = global.fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("preflightModels passes when both models present", async () => {
  global.fetch = async () =>
    jsonResponse({
      models: [
        { name: "qwen3.5:9b" },
        { name: "embeddinggemma:300m" },
      ],
    });
  const res = await preflightModels({ requireEmbed: true });
  assert.ok(res.installed.includes("qwen3.5:9b"));
  assert.ok(res.installed.includes("embeddinggemma:300m"));
});

test("preflightModels throws with pull hint when chat model missing", async () => {
  global.fetch = async () =>
    jsonResponse({ models: [{ name: "embeddinggemma:300m" }] });
  await assert.rejects(
    () => preflightModels({ requireEmbed: true }),
    /Model "qwen3\.5:9b" not available\. Run: ollama pull qwen3\.5:9b/,
  );
});

test("preflightModels throws with pull hint when embed model missing", async () => {
  global.fetch = async () =>
    jsonResponse({ models: [{ name: "qwen3.5:9b" }] });
  await assert.rejects(
    () => preflightModels({ requireEmbed: true }),
    /Model "embeddinggemma:300m" not available\. Run: ollama pull embeddinggemma:300m/,
  );
});

test("preflightModels skips embed check when requireEmbed=false", async () => {
  global.fetch = async () => jsonResponse({ models: [{ name: "qwen3.5:9b" }] });
  const res = await preflightModels({ requireEmbed: false });
  assert.deepEqual(res.installed, ["qwen3.5:9b"]);
});

test("preflightModels surfaces non-2xx as an error", async () => {
  global.fetch = async () => new Response("kaboom", { status: 500 });
  await assert.rejects(() => preflightModels({ requireEmbed: false }), /500/);
});
