// Timestamped artifact persistence for successful agent and full-run executions.
// See spec section "Timestamped Agent Results - 2026-06-27" and docs/why.md.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

const UNSAFE = /[^A-Za-z0-9._-]+/g;

export function timestampForFilename(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

export function slugify(name) {
  if (!name) return "stdin";
  const cleaned = String(name).replace(UNSAFE, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return cleaned || "stdin";
}

export function slugFromBriefPath(briefPath) {
  if (!briefPath) return "stdin";
  const base = basename(String(briefPath));
  const stem = base.endsWith(extname(base)) ? base.slice(0, -extname(base).length) : base;
  return slugify(stem);
}

export function buildArtifactFilename({ slug, ext, now = Date.now() }) {
  if (ext !== "md" && ext !== "json") {
    throw new Error(`buildArtifactFilename: ext must be 'md' or 'json' (got "${ext}")`);
  }
  return `${timestampForFilename(now)}-${slugify(slug)}.${ext}`;
}

export async function persistAgentArtifact({ dir, slug, format, content, now = Date.now() }) {
  if (format !== "md" && format !== "json") {
    throw new Error(`persistAgentArtifact: format must be 'md' or 'json' (got "${format}")`);
  }
  await mkdir(dir, { recursive: true });
  const filename = buildArtifactFilename({ slug, ext: format, now });
  const path = join(dir, filename);
  await writeFile(path, content, "utf8");
  return path;
}
