const HEAD_MAX = 200;

export function truncateHead(value, max = HEAD_MAX) {
  if (value == null) return undefined;
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class LlmError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = this.constructor.name;
    if (opts.cause !== undefined) this.cause = opts.cause;
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.durationMs !== undefined) this.durationMs = opts.durationMs;
    if (opts.attempt !== undefined) this.attempt = opts.attempt;
    const ph = truncateHead(opts.promptHead);
    if (ph !== undefined) this.promptHead = ph;
    const rh = truncateHead(opts.responseHead);
    if (rh !== undefined) this.responseHead = rh;
  }
}

export class LlmUnavailableError extends LlmError {}
export class LlmServerError extends LlmError {}
export class LlmTimeoutError extends LlmError {}
export class LlmModelNotFoundError extends LlmError {}
export class LlmJsonParseError extends LlmError {}
export class LlmContextOverflowError extends LlmError {}
export class LlmInvariantError extends LlmError {}

// Backwards-compatible aliases. Same class identity, so `instanceof` checks
// against either the Ollama* or Llm* name continue to work for any caller
// that has not yet migrated. See Stage 1 of the legacy Ollama identifier
// rename plan for context.
export const OllamaError = LlmError;
export const OllamaUnavailableError = LlmUnavailableError;
export const OllamaServerError = LlmServerError;
export const OllamaTimeoutError = LlmTimeoutError;
export const OllamaModelNotFoundError = LlmModelNotFoundError;
export const OllamaJsonParseError = LlmJsonParseError;
export const OllamaContextOverflowError = LlmContextOverflowError;
export const OllamaInvariantError = LlmInvariantError;
