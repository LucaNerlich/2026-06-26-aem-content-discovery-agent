import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// shared/src/config/models.js → ../../../ = repo root
const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODELS_CONFIG_PATH = resolve(HERE, "..", "..", "..", "config", "models.json");

let cache = null;

function validate(parsed, path) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config/models.json must be a JSON object (read from ${path})`);
  }
  if (!parsed.chat || typeof parsed.chat !== "object") {
    throw new Error(`config/models.json: "chat" object is required (read from ${path})`);
  }
  if (typeof parsed.chat.default !== "string" || parsed.chat.default.length === 0) {
    throw new Error(
      `config/models.json: "chat.default" must be a non-empty string (read from ${path})`,
    );
  }
  if (!parsed.embedding || typeof parsed.embedding !== "object") {
    throw new Error(`config/models.json: "embedding" object is required (read from ${path})`);
  }
  if (typeof parsed.embedding.default !== "string" || parsed.embedding.default.length === 0) {
    throw new Error(
      `config/models.json: "embedding.default" must be a non-empty string (read from ${path})`,
    );
  }
}

export function loadModelsConfig({ path = DEFAULT_MODELS_CONFIG_PATH } = {}) {
  if (path === DEFAULT_MODELS_CONFIG_PATH && cache) return cache;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      throw new Error(`config/models.json not found at ${path}`);
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config/models.json is not valid JSON (read from ${path}): ${err.message}`);
  }
  validate(parsed, path);
  if (path === DEFAULT_MODELS_CONFIG_PATH) cache = parsed;
  return parsed;
}

export function getChatModel(stage = "default", opts) {
  const cfg = loadModelsConfig(opts);
  if (stage && stage !== "default") {
    const override = cfg.chat[stage];
    if (typeof override === "string" && override.length > 0) return override;
  }
  return cfg.chat.default;
}

export function getEmbeddingModel(opts) {
  const cfg = loadModelsConfig(opts);
  return cfg.embedding.default;
}

export function resetModelsConfigCache() {
  cache = null;
}
