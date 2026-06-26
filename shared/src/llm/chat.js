import { ollamaFetch, CHAT_MODEL, logger } from "./ollama.js";
import { appendPromptLog } from "./prompt-log.js";
import {
  OllamaInvariantError,
  OllamaJsonParseError,
  truncateHead,
} from "./errors.js";

const CHAT_TIMEOUT_MS = 120_000;

function buildPromptHead(system, user) {
  return [system ? `system: ${system}` : null, `user: ${user}`].filter(Boolean).join(" | ");
}

export async function chat({ system, user, json = false, model = CHAT_MODEL, options } = {}) {
  if (!user || typeof user !== "string") {
    throw new TypeError("chat({ user }) requires a non-empty string");
  }
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  const body = {
    model,
    messages,
    stream: false,
    options: { temperature: 1.0, top_p: 0.95, top_k: 64, ...(options ?? {}) },
  };
  if (json) body.format = "json";

  const startedAt = Date.now();
  const promptHead = buildPromptHead(system, user);
  let content = "";
  try {
    const res = await ollamaFetch("/api/chat", body, {
      timeoutMs: CHAT_TIMEOUT_MS,
      retries: 1,
      model,
      promptHead,
    });

    content = res?.message?.content ?? "";
    const durationMs = Date.now() - startedAt;

    if (!res || !res.message || typeof res.message.content !== "string" || content.length === 0) {
      throw new OllamaInvariantError("Ollama chat returned empty or malformed response", {
        model,
        durationMs,
        promptHead,
        responseHead: JSON.stringify(res ?? null),
      });
    }

    let parsed = content;
    if (json) {
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        throw new OllamaJsonParseError(
          `Ollama chat response is not valid JSON: ${parseErr.message}`,
          { cause: parseErr, model, durationMs, promptHead, responseHead: content },
        );
      }
    }

    logger.info(
      {
        model,
        durationMs,
        promptTokens: res.prompt_eval_count,
        evalTokens: res.eval_count,
        ok: true,
      },
      "chat",
    );
    await appendPromptLog({ model, system, user, response: content, ok: true, durationMs });
    return parsed;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    logger.error(
      { model, durationMs, ok: false, errorClass: err.name, err: truncateHead(err.message) },
      "chat failed",
    );
    await appendPromptLog({ model, system, user, error: err, ok: false, durationMs });
    throw err;
  }
}
