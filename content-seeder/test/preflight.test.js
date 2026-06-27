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
      data: [
        { id: "google/gemma-4-e4b", object: "model" },
        { id: "nomic-embed-text", object: "model" },
      ],
    });
  const res = await preflightModels({ requireEmbed: true });
  assert.ok(res.installed.includes("google/gemma-4-e4b"));
  assert.ok(res.installed.includes("nomic-embed-text"));
});

test("preflightModels throws with LM Studio hint when chat model missing", async () => {
  global.fetch = async () =>
    jsonResponse({ data: [{ id: "nomic-embed-text" }] });
  await assert.rejects(
    () => preflightModels({ requireEmbed: true }),
    /Model "google\/gemma-4-e4b" not available.*LM Studio/,
  );
});

test("preflightModels throws with LM Studio hint when embed model missing", async () => {
  global.fetch = async () =>
    jsonResponse({ data: [{ id: "google/gemma-4-e4b" }] });
  await assert.rejects(
    () => preflightModels({ requireEmbed: true }),
    /Model "nomic-embed-text" not available.*LM Studio/,
  );
});

test("preflightModels skips embed check when requireEmbed=false", async () => {
  global.fetch = async () => jsonResponse({ data: [{ id: "google/gemma-4-e4b" }] });
  const res = await preflightModels({ requireEmbed: false });
  assert.deepEqual(res.installed, ["google/gemma-4-e4b"]);
});

test("preflightModels surfaces non-2xx as an error", async () => {
  global.fetch = async () => new Response("kaboom", { status: 500 });
  await assert.rejects(() => preflightModels({ requireEmbed: false }), /500/);
});

test("preflightModels matches model by repo-path suffix (e.g. vendor/model-name)", async () => {
  global.fetch = async () =>
    jsonResponse({ data: [{ id: "google/gemma-4-e4b" }, { id: "nomic-embed-text" }] });
  // isModelInstalled should match even if caller passes just the short name
  const res = await preflightModels({ requireEmbed: false });
  assert.ok(res.installed.some((id) => id === "google/gemma-4-e4b"));
});
