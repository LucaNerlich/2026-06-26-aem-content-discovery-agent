import { ollamaFetch, EMBED_MODEL, logger } from "./ollama.js";
import { OllamaInvariantError } from "./errors.js";

const EMBED_TIMEOUT_MS = 10_000;

function toFloat32(arr) {
  if (!Array.isArray(arr)) {
    throw new OllamaInvariantError("Ollama embed returned a non-array vector");
  }
  return Float32Array.from(arr);
}

export async function embed(input, { model = EMBED_MODEL } = {}) {
  const wantsBatch = Array.isArray(input);
  const inputs = wantsBatch ? input : [input];
  if (inputs.length === 0 || inputs.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new TypeError("embed(input) requires a non-empty string or string[]");
  }

  const startedAt = Date.now();
  const promptHead = wantsBatch ? `[batch:${inputs.length}] ${inputs[0]}` : inputs[0];
  try {
    const res = await ollamaFetch(
      "/api/embed",
      { model, input: wantsBatch ? inputs : inputs[0] },
      { timeoutMs: EMBED_TIMEOUT_MS, retries: 1, model, promptHead },
    );

    const durationMs = Date.now() - startedAt;
    const embeddings = res?.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length === 0) {
      throw new OllamaInvariantError("Ollama embed response missing `embeddings` array", {
        model,
        durationMs,
        promptHead,
        responseHead: JSON.stringify(res ?? null),
      });
    }
    if (embeddings.length !== inputs.length) {
      throw new OllamaInvariantError(
        `Ollama embed returned ${embeddings.length} vectors for ${inputs.length} inputs`,
        { model, durationMs, promptHead, responseHead: JSON.stringify(res) },
      );
    }

    logger.info({ model, durationMs, count: embeddings.length, ok: true }, "embed");
    const vectors = embeddings.map(toFloat32);
    return wantsBatch ? vectors : vectors[0];
  } catch (err) {
    logger.error(
      { model, durationMs: Date.now() - startedAt, ok: false, errorClass: err.name },
      "embed failed",
    );
    throw err;
  }
}
