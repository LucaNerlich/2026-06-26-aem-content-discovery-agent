import { getHost, CHAT_MODEL, EMBED_MODEL } from "@aemdisc/shared";

const PREFLIGHT_TIMEOUT_MS = 5_000;

export async function listOllamaModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(`${getHost()}/api/tags`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Ollama /api/tags responded ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    const models = body?.models ?? [];
    return models.map((m) => m?.name).filter(Boolean);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Ollama /api/tags timed out after ${PREFLIGHT_TIMEOUT_MS}ms (host: ${getHost()})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isModelInstalled(installed, wanted) {
  // Tag names from /api/tags include the tag suffix (e.g. "gemma4:26b").
  return installed.some((name) => name === wanted || name.startsWith(`${wanted}:`));
}

export async function preflightModels({ requireEmbed }) {
  const installed = await listOllamaModels();
  const missing = [];
  if (!isModelInstalled(installed, CHAT_MODEL)) missing.push(CHAT_MODEL);
  if (requireEmbed && !isModelInstalled(installed, EMBED_MODEL)) missing.push(EMBED_MODEL);
  if (missing.length > 0) {
    const first = missing[0];
    const err = new Error(
      `Model "${first}" not available. Run: ollama pull ${first}`,
    );
    err.missing = missing;
    throw err;
  }
  return { installed };
}
