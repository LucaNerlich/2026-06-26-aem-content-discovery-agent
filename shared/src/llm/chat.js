import { llmFetch, logger } from "./llm.js";
import { appendPromptLog } from "./prompt-log.js";
import {
  LlmInvariantError,
  LlmJsonParseError,
  truncateHead,
} from "./errors.js";
import { getChatModel } from "../config/models.js";

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

function getChatTimeoutMs() {
  const raw = process.env.CHAT_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_CHAT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CHAT_TIMEOUT_MS;
  return n;
}

function buildPromptHead(system, user) {
  return [system ? `system: ${system}` : null, `user: ${user}`].filter(Boolean).join(" | ");
}

const THINK_BLOCK_REGEX = /^\s*<think>([\s\S]*?)<\/think>\s*/i;
const THINK_OPEN_REGEX = /^\s*<think>/i;

/**
 * Call the LM Studio /v1/chat/completions endpoint (OpenAI-compatible).
 *
 * @param {object} args
 * @param {string} [args.system]    optional system message
 * @param {string}  args.user       required user message
 * @param {boolean} [args.json]     if true, JSON.parses the reply (prompt-driven; LM Studio compat)
 * @param {string}  [args.model]    chat model id; defaults to the configured chat default
 * @param {object}  [args.options]  legacy options-shape block. Supported keys forwarded as-is:
 *                                  `num_predict`, `temperature`, `top_p`, `top_k`, `seed`, `stop`, `think`.
 *
 * Thinking-model handling:
 *  - The reply is stripped of a leading `<think>...</think>` block (model-agnostic safety net).
 *  - A reply starting with `<think>` but lacking a closing tag throws LlmInvariantError
 *    with "truncated mid-think" — caller should raise `num_predict` or set DISABLE_THINKING_MODE=true.
 *  - When DISABLE_THINKING_MODE is truthy AND the model matches /^qwen3/i, `think: false` is sent.
 */
export async function chat({ system, user, json = false, model = getChatModel("default"), options } = {}) {
  if (!user || typeof user !== "string") {
    throw new TypeError("chat({ user }) requires a non-empty string");
  }
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });

  // Map legacy options-shape keys to OpenAI-compat top-level fields.
  const { temperature = 1.0, top_p = 0.95, num_predict, stop, seed: optSeed } = options ?? {};
  const body = {
    model,
    messages,
    stream: false,
    temperature,
    top_p,
    ...(num_predict != null ? { max_tokens: num_predict } : {}),
    ...(stop != null ? { stop } : {}),
    ...(optSeed != null ? { seed: optSeed } : {}),
  };
  // LM Studio only accepts "json_schema" or "text"; rely on prompt instructions + JSON.parse instead.

  const startedAt = Date.now();
  const promptHead = buildPromptHead(system, user);
  let content = "";
  try {
    const res = await llmFetch("/v1/chat/completions", body, {
      timeoutMs: getChatTimeoutMs(),
      retries: 1,
      model,
      promptHead,
    });

    content = res?.choices?.[0]?.message?.content ?? "";
    const durationMs = Date.now() - startedAt;

    if (!res?.choices?.[0]?.message || typeof content !== "string") {
      throw new LlmInvariantError("LM Studio chat returned empty or malformed response", {
        model,
        durationMs,
        promptHead,
        responseHead: JSON.stringify(res ?? null),
      });
    }

    // Safety net: strip leading <think>...</think> block from any thinking model.
    const thinkMatch = content.match(THINK_BLOCK_REGEX);
    if (thinkMatch) {
      const stripped = thinkMatch[0].length;
      content = content.slice(thinkMatch[0].length);
      logger.info({ model, thinkBytesStripped: stripped }, "stripped think block");
    } else if (THINK_OPEN_REGEX.test(content)) {
      throw new LlmInvariantError(
        "Response truncated mid-think — increase max_tokens",
        { model, durationMs, promptHead, responseHead: content },
      );
    }

    if (content.length === 0) {
      throw new LlmInvariantError("LM Studio chat returned empty response", {
        model,
        durationMs,
        promptHead,
        responseHead: JSON.stringify(res ?? null),
      });
    }

    let parsed = content;
    if (json) {
      // Strip markdown code fences that some models (e.g. Gemma) emit even without response_format.
      const fenceMatch = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
      if (fenceMatch) content = fenceMatch[1];
      try {
        parsed = JSON.parse(content);
      } catch (parseErr) {
        throw new LlmJsonParseError(
          `Chat response is not valid JSON: ${parseErr.message}`,
          { cause: parseErr, model, durationMs, promptHead, responseHead: content },
        );
      }
    }

    logger.info(
      {
        model,
        durationMs,
        promptTokens: res.usage?.prompt_tokens,
        evalTokens: res.usage?.completion_tokens,
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
