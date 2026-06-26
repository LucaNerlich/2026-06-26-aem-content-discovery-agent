export { chat } from "./chat.js";
export { embed } from "./embed.js";
export { CHAT_MODEL, EMBED_MODEL, DEFAULT_HOST, getHost, ollamaFetch, logger } from "./ollama.js";
export { appendPromptLog, getPromptLogPath } from "./prompt-log.js";
export {
  OllamaError,
  OllamaUnavailableError,
  OllamaServerError,
  OllamaTimeoutError,
  OllamaModelNotFoundError,
  OllamaJsonParseError,
  OllamaContextOverflowError,
  OllamaInvariantError,
  truncateHead,
} from "./errors.js";
