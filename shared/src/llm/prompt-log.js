import { appendFile, mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { truncateHead } from "./errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOG_PATH = resolve(HERE, "../../../prompt-log.md");
const HEADER = "# Prompt Log\n\n";

export function getPromptLogPath() {
  return process.env.PROMPT_LOG_PATH ?? DEFAULT_LOG_PATH;
}

async function ensureFile(path) {
  try {
    await access(path, constants.F_OK);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, HEADER, "utf8");
  }
}

export async function appendPromptLog({
  model,
  system,
  user,
  response,
  error,
  ok,
  durationMs,
}) {
  const path = getPromptLogPath();
  await ensureFile(path);
  const okFlag = typeof ok === "boolean" ? ok : !error;
  const lines = [
    `## ${new Date().toISOString()} — ${model ?? "<unknown>"}`,
    `- ok: ${okFlag}`,
    `- durationMs: ${durationMs ?? "n/a"}`,
    `- system: ${truncateHead(system) ?? ""}`,
    `- user: ${truncateHead(user) ?? ""}`,
  ];
  if (error) {
    lines.push(`- errorClass: ${error.name ?? "Error"}`);
    lines.push(`- errorMessageHead: ${truncateHead(error.message) ?? ""}`);
  } else {
    lines.push(`- response: ${truncateHead(response) ?? ""}`);
  }
  lines.push("", "");
  await appendFile(path, lines.join("\n"), "utf8");
}
