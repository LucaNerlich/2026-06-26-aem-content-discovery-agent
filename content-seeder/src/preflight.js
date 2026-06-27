import { getHost, loadModelsConfig, getChatModel, getEmbeddingModel } from "@aemdisc/shared";

const PREFLIGHT_TIMEOUT_MS = 5_000;

function distinctChatModels() {
  const cfg = loadModelsConfig();
  const out = new Set();
  for (const value of Object.values(cfg.chat ?? {})) {
    if (typeof value === "string" && value.length > 0) out.add(value);
  }
  if (out.size === 0) out.add(getChatModel("default"));
  return [...out];
}

export async function listOllamaModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    const res = await fetch(`${getHost()}/v1/models`, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`LM Studio /v1/models responded ${res.status} ${res.statusText}`);
    }
    const body = await res.json();
    // OpenAI-compat: { data: [{ id: "...", object: "model" }] }
    const models = body?.data ?? [];
    return models.map((m) => m?.id).filter(Boolean);
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`LM Studio /v1/models timed out after ${PREFLIGHT_TIMEOUT_MS}ms (host: ${getHost()})`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function isModelInstalled(installed, wanted) {
  // LM Studio model IDs are full repo-style paths (e.g. "google/gemma-4-e4b").
  return installed.some((id) => id === wanted || id.endsWith(`/${wanted}`));
}

export async function preflightModels({ requireEmbed }) {
  const installed = await listOllamaModels();
  const missing = [];
  for (const chatModel of distinctChatModels()) {
    if (!isModelInstalled(installed, chatModel)) missing.push(chatModel);
  }
  if (requireEmbed) {
    const embedModel = getEmbeddingModel();
    if (!isModelInstalled(installed, embedModel)) missing.push(embedModel);
  }
  if (missing.length > 0) {
    const first = missing[0];
    const err = new Error(
      `Model "${first}" not available. Ensure it is loaded in LM Studio (host: ${getHost()})`,
    );
    err.missing = missing;
    throw err;
  }
  return { installed };
}
