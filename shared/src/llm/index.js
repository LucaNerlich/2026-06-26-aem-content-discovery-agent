export { chat } from "./chat.js";
export { embed } from "./embed.js";
export {
  CHAT_MODEL,
  EMBED_MODEL,
  DEFAULT_HOST,
  getHost,
  llmFetch,
  ollamaFetch,
  logger,
} from "./ollama.js";
export { appendPromptLog, getPromptLogPath } from "./prompt-log.js";
export {
  LlmError,
  LlmUnavailableError,
  LlmServerError,
  LlmTimeoutError,
  LlmModelNotFoundError,
  LlmJsonParseError,
  LlmContextOverflowError,
  LlmInvariantError,
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
