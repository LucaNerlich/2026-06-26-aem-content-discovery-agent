const HEAD_MAX = 200;

export function truncateHead(value, max = HEAD_MAX) {
  if (value == null) return undefined;
  const s = String(value).replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export class OllamaError extends Error {
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

export class OllamaUnavailableError extends OllamaError {}
export class OllamaServerError extends OllamaError {}
export class OllamaTimeoutError extends OllamaError {}
export class OllamaModelNotFoundError extends OllamaError {}
export class OllamaJsonParseError extends OllamaError {}
export class OllamaContextOverflowError extends OllamaError {}
export class OllamaInvariantError extends OllamaError {}
