import { llmFetch, logger } from "./ollama.js";
import { LlmInvariantError } from "./errors.js";
import { getEmbeddingModel } from "../config/models.js";

const EMBED_TIMEOUT_MS = 10_000;

function toFloat32(arr) {
  if (!Array.isArray(arr)) {
    throw new LlmInvariantError("LLM embed returned a non-array vector");
  }
  return Float32Array.from(arr);
}

export async function embed(input, { model = getEmbeddingModel() } = {}) {
  const wantsBatch = Array.isArray(input);
  const inputs = wantsBatch ? input : [input];
  if (inputs.length === 0 || inputs.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new TypeError("embed(input) requires a non-empty string or string[]");
  }

  const startedAt = Date.now();
  const promptHead = wantsBatch ? `[batch:${inputs.length}] ${inputs[0]}` : inputs[0];
  try {
    const res = await llmFetch(
      "/v1/embeddings",
      { model, input: wantsBatch ? inputs : inputs[0] },
      { timeoutMs: EMBED_TIMEOUT_MS, retries: 1, model, promptHead },
    );

    const durationMs = Date.now() - startedAt;
    const data = res?.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new LlmInvariantError("LM Studio embed response missing `data` array", {
        model,
        durationMs,
        promptHead,
        responseHead: JSON.stringify(res ?? null),
      });
    }
    if (data.length !== inputs.length) {
      throw new LlmInvariantError(
        `LM Studio embed returned ${data.length} vectors for ${inputs.length} inputs`,
        { model, durationMs, promptHead, responseHead: JSON.stringify(res) },
      );
    }

    logger.info({ model, durationMs, count: data.length, ok: true }, "embed");
    const vectors = data.map((d) => toFloat32(d.embedding));
    return wantsBatch ? vectors : vectors[0];
  } catch (err) {
    logger.error(
      { model, durationMs: Date.now() - startedAt, ok: false, errorClass: err.name },
      "embed failed",
    );
    throw err;
  }
}
