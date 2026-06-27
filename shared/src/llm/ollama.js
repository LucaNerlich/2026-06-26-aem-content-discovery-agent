import pino from "pino";
import {
  OllamaUnavailableError,
  OllamaServerError,
  OllamaTimeoutError,
  OllamaModelNotFoundError,
  OllamaContextOverflowError,
} from "./errors.js";
import { getChatModel, getEmbeddingModel } from "../config/models.js";

export const DEFAULT_HOST = "http://localhost:1234";
// Backwards-compatible defaults sourced from config/models.json. Per-stage
// overrides flow through getChatModel(stage) at the call sites.
export const CHAT_MODEL = getChatModel("default");
export const EMBED_MODEL = getEmbeddingModel();

export const logger = pino({
  name: "ollama",
  level: process.env.LOG_LEVEL ?? "info",
});

export function getHost() {
  return process.env.OLLAMA_HOST ?? DEFAULT_HOST;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeModelMissing(text) {
  if (!text) return false;
  return /model .* not found|pull the model|no such model|could not find/i.test(text);
}

function looksLikeContextOverflow(text) {
  if (!text) return false;
  return /context length|context window|too many tokens|exceeds (the )?context/i.test(text);
}

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export async function ollamaFetch(path, body, opts = {}) {
  const { timeoutMs, retries = 1, model, promptHead } = opts;
  const url = `${getHost()}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (fetchErr) {
        const durationMs = Date.now() - startedAt;
        if (fetchErr.name === "AbortError") {
          throw new OllamaTimeoutError(`Ollama ${path} timed out after ${timeoutMs}ms`, {
            cause: fetchErr,
            model,
            durationMs,
            promptHead,
            attempt,
          });
        }
        const unavailable = new OllamaUnavailableError(
          `Ollama ${path} unreachable: ${fetchErr.message}`,
          { cause: fetchErr, model, durationMs, promptHead, attempt },
        );
        lastErr = unavailable;
        if (attempt <= retries) {
          await sleep(200 * attempt);
          continue;
        }
        throw unavailable;
      }

      const durationMs = Date.now() - startedAt;
      if (!res.ok) {
        const text = await readErrorBody(res);
        const baseFields = { model, durationMs, promptHead, responseHead: text, attempt };
        if (res.status === 404 || looksLikeModelMissing(text)) {
          throw new OllamaModelNotFoundError(
            `Model not found${model ? ` (${model})` : ""} — ensure it is loaded in LM Studio`,
            baseFields,
          );
        }
        if (looksLikeContextOverflow(text)) {
          throw new OllamaContextOverflowError(
            `Ollama ${path} input exceeds context window`,
            baseFields,
          );
        }
        if (res.status >= 500 && res.status < 600) {
          const serverErr = new OllamaServerError(
            `Ollama ${path} ${res.status}: ${text || res.statusText}`,
            baseFields,
          );
          lastErr = serverErr;
          if (attempt <= retries) {
            await sleep(200 * attempt);
            continue;
          }
          throw serverErr;
        }
        throw new OllamaServerError(
          `Ollama ${path} ${res.status}: ${text || res.statusText}`,
          baseFields,
        );
      }

      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr;
}
