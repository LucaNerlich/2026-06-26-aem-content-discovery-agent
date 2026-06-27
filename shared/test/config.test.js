import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadModelsConfig,
  getChatModel,
  getEmbeddingModel,
  resetModelsConfigCache,
} from "../src/config/models.js";

let tmpDir;
let cfgPath;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "models-config-"));
  cfgPath = join(tmpDir, "models.json");
  resetModelsConfigCache();
});

afterEach(async () => {
  resetModelsConfigCache();
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeCfg(obj) {
  await writeFile(cfgPath, JSON.stringify(obj), "utf8");
}

test("loadModelsConfig happy path returns parsed object", async () => {
  await writeCfg({
    chat: { default: "gemma4:26b", compose: "gemma4:26b" },
    embedding: { default: "embeddinggemma:300m" },
  });
  const cfg = loadModelsConfig({ path: cfgPath });
  assert.equal(cfg.chat.default, "gemma4:26b");
  assert.equal(cfg.embedding.default, "embeddinggemma:300m");
});

test("loadModelsConfig throws clear error when file is missing", () => {
  assert.throws(
    () => loadModelsConfig({ path: join(tmpDir, "missing.json") }),
    /config\/models\.json not found/,
  );
});

test("loadModelsConfig throws clear error on invalid JSON", async () => {
  await writeFile(cfgPath, "{ not json", "utf8");
  assert.throws(
    () => loadModelsConfig({ path: cfgPath }),
    /config\/models\.json is not valid JSON/,
  );
});

test("loadModelsConfig throws when chat.default is missing", async () => {
  await writeCfg({ chat: {}, embedding: { default: "embeddinggemma:300m" } });
  assert.throws(
    () => loadModelsConfig({ path: cfgPath }),
    /chat\.default.*must be a non-empty string/,
  );
});

test("loadModelsConfig throws when embedding.default is missing", async () => {
  await writeCfg({ chat: { default: "gemma4:26b" }, embedding: {} });
  assert.throws(
    () => loadModelsConfig({ path: cfgPath }),
    /embedding\.default.*must be a non-empty string/,
  );
});

test("loadModelsConfig throws when chat is missing entirely", async () => {
  await writeCfg({ embedding: { default: "embeddinggemma:300m" } });
  assert.throws(() => loadModelsConfig({ path: cfgPath }), /"chat" object is required/);
});

test("getChatModel returns per-stage override when set", async () => {
  await writeCfg({
    chat: { default: "gemma4:26b", compose: "smolm-3:8b" },
    embedding: { default: "embeddinggemma:300m" },
  });
  assert.equal(getChatModel("compose", { path: cfgPath }), "smolm-3:8b");
});

test("getChatModel falls back to default when per-stage override is missing", async () => {
  await writeCfg({
    chat: { default: "gemma4:26b" },
    embedding: { default: "embeddinggemma:300m" },
  });
  assert.equal(getChatModel("parseBrief", { path: cfgPath }), "gemma4:26b");
});

test("getChatModel('default') returns chat.default", async () => {
  await writeCfg({
    chat: { default: "gemma4:26b", compose: "other:7b" },
    embedding: { default: "embeddinggemma:300m" },
  });
  assert.equal(getChatModel("default", { path: cfgPath }), "gemma4:26b");
});

test("getChatModel ignores empty-string per-stage override and falls back", async () => {
  await writeCfg({
    chat: { default: "gemma4:26b", compose: "" },
    embedding: { default: "embeddinggemma:300m" },
  });
  assert.equal(getChatModel("compose", { path: cfgPath }), "gemma4:26b");
});

test("getEmbeddingModel returns embedding.default", async () => {
  await writeCfg({
    chat: { default: "gemma4:26b" },
    embedding: { default: "embeddinggemma:300m" },
  });
  assert.equal(getEmbeddingModel({ path: cfgPath }), "embeddinggemma:300m");
});

test("default config at repo root is loadable and valid", () => {
  const cfg = loadModelsConfig();
  assert.equal(typeof cfg.chat.default, "string");
  assert.ok(cfg.chat.default.length > 0);
  assert.equal(typeof cfg.embedding.default, "string");
  assert.ok(cfg.embedding.default.length > 0);
});
