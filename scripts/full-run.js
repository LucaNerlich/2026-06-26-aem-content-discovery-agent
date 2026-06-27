#!/usr/bin/env node
// Full-run harness: drives the discovery agent against every brief in
// eval/briefs/ and captures both the validated AgentOutput JSON and the
// rendered Markdown for each into runs/full-run/. See Task 15 in the spec
// and the "Why split into 15a/15b/15c" entry in why.md.
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentOutput,
  JsonFragmentSource,
  getChatModel,
  getEmbeddingModel,
} from "@aemdisc/shared";

// 5min default per chat call — gemma-class 9b models still need >120s under
// load on consumer hardware. User can override via env.
process.env.CHAT_TIMEOUT_MS ??= "300000";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BRIEFS_DIR = join(ROOT, "eval", "briefs");
const EXPECTATIONS_DIR = join(ROOT, "eval", "expectations");
const RUNS_DIR = join(ROOT, "runs", "full-run");
const CORPUS_PATH = join(ROOT, "data", "corpus.json");

// Locked seed — mirrors eval/run.js DEMO_SEED so the README header is honest
// about which seeded snapshot the run was produced against.
export const DEMO_SEED = 20260626;

const LOCALE_RE = /^(en-gb|en-us|fr-fr|de-de)-/;
const KNOWN_LOCALES = new Set(["en-gb", "en-us", "fr-fr", "de-de"]);
const TEXT_LOCALE_RE = /\b(en-gb|en-us|fr-fr|de-de)\b/i;

export function localeFromSlug(slug) {
  const m = LOCALE_RE.exec(slug);
  return m ? m[1] : "n/a";
}

// Locale inference order: slug prefix → eval/expectations/<slug>.json
// localeOverride → first locale token in the brief text → "n/a".
export async function inferLocale(slug, briefText, expectationsDir = EXPECTATIONS_DIR) {
  const fromSlug = LOCALE_RE.exec(slug);
  if (fromSlug) return fromSlug[1];
  const expPath = join(expectationsDir, `${slug}.json`);
  if (existsSync(expPath)) {
    try {
      const exp = JSON.parse(await readFile(expPath, "utf8"));
      if (typeof exp?.localeOverride === "string" && KNOWN_LOCALES.has(exp.localeOverride)) {
        return exp.localeOverride;
      }
    } catch {
      // fall through to text scan
    }
  }
  if (typeof briefText === "string") {
    const m = briefText.match(TEXT_LOCALE_RE);
    if (m) return m[1].toLowerCase();
  }
  return "n/a";
}

// Validates that data/corpus.json was seeded and covers all three locales.
// Returns { ok: true } on success or { ok: false, reason } with an actionable
// message on failure.
export async function corpusPrecheck(corpusPath = CORPUS_PATH) {
  if (!existsSync(corpusPath)) {
    return { ok: false, reason: `data/corpus.json missing at ${corpusPath}` };
  }
  let corpus;
  try {
    corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  } catch (err) {
    return { ok: false, reason: `data/corpus.json is not valid JSON: ${err.message}` };
  }
  const fragments = Array.isArray(corpus?.fragments) ? corpus.fragments : [];
  if (fragments.length < 24) {
    return { ok: false, reason: `expected >= 24 fragments, got ${fragments.length}` };
  }
  const have = new Set(fragments.map((f) => f.locale));
  const required = ["en-gb", "fr-fr", "de-de"];
  const missing = required.filter((l) => !have.has(l));
  if (missing.length > 0) {
    return { ok: false, reason: `missing locales: ${missing.join(", ")}` };
  }
  return { ok: true };
}

export async function listBriefs(dir = BRIEFS_DIR) {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ slug: basename(f, ".txt"), file: join(dir, f) }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Wraps each pipeline stage with timing instrumentation that runPipeline
// otherwise hides. Stage names match the keys promised in meta.stageDurations.
export function instrumentStages(stages, now = () => Date.now()) {
  const stageDurations = {};
  const wrap = (name, fn) => async (...args) => {
    const t = now();
    try {
      return await fn(...args);
    } finally {
      stageDurations[name] = (now() - t) | 0;
    }
  };
  return {
    deps: {
      parseBrief: wrap("parseBrief", stages.parseBrief),
      retrieve: wrap("retrieve", stages.retrieve),
      analyseGaps: wrap("analyseGaps", stages.analyseGaps),
      compose: wrap("compose", stages.compose),
    },
    stageDurations,
  };
}

function gapCounts(gaps) {
  const counts = { none: 0, partial: 0 };
  for (const g of gaps ?? []) {
    if (g.coverage === "none") counts.none += 1;
    else if (g.coverage === "partial") counts.partial += 1;
  }
  return counts;
}

// Single brief, no retry. Validates the AgentOutput before rendering so a
// schema drift surfaces as a thrown error the caller can retry on. On
// failure the partial stageDurations are attached to the thrown error so
// the retry wrapper can persist whatever timing was captured before the
// stage threw.
export async function runBriefOnce({ slug, text, source, runPipeline, stages, render, now = () => Date.now() }) {
  const { deps, stageDurations } = instrumentStages(stages, now);
  try {
    const output = await runPipeline(text, { source, k: 3 }, deps);
    AgentOutput.parse(output);
    const md = render(output);
    return { slug, output, md, stageDurations };
  } catch (err) {
    if (err && typeof err === "object") {
      try { err.stageDurations = stageDurations; } catch { /* frozen */ }
    }
    throw err;
  }
}

export async function writeBriefArtifacts(runsDir, slug, { output, md }) {
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${slug}.json`), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(join(runsDir, `${slug}.md`), `${md}\n`, "utf8");
}

export async function writeMeta(runsDir, slug, meta) {
  await mkdir(runsDir, { recursive: true });
  await writeFile(join(runsDir, `${slug}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

// One-retry wrapper. On second failure records status=error|timeout and
// writes ONLY .meta.json so a downstream reader knows the brief ran but
// produced no usable output. Never re-throws.
export async function runBriefWithRetry(briefRec, ctx) {
  const { source, runPipeline, stages, render, runsDir, chatModel, embeddingModel, now = () => Date.now() } = ctx;
  const briefText = briefRec.text;
  const startedAt = new Date(now()).toISOString();
  const t0 = now();
  let lastError;
  let lastStageDurations = {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { output, md, stageDurations } = await runBriefOnce({
        slug: briefRec.slug,
        text: briefText,
        source,
        runPipeline,
        stages,
        render,
        now,
      });
      const finishedAt = new Date(now()).toISOString();
      const durationMs = (now() - t0) | 0;
      await writeBriefArtifacts(runsDir, briefRec.slug, { output, md });
      const meta = {
        slug: briefRec.slug,
        brief: briefText.slice(0, 200),
        locale: briefRec.locale ?? localeFromSlug(briefRec.slug),
        startedAt,
        finishedAt,
        durationMs,
        stageDurations,
        chatModel,
        embeddingModel,
        matchedFragmentCount: output.matchedFragments.length,
        gapCounts: gapCounts(output.gaps),
        status: "ok",
        retryCount: attempt,
      };
      await writeMeta(runsDir, briefRec.slug, meta);
      return meta;
    } catch (err) {
      lastError = err;
      if (err && typeof err === "object" && err.stageDurations) {
        lastStageDurations = err.stageDurations;
      }
    }
  }
  const finishedAt = new Date(now()).toISOString();
  const durationMs = (now() - t0) | 0;
  const msg = String(lastError?.message ?? lastError);
  const isTimeout = /timeout|timed out|OllamaTimeoutError/i.test(msg);
  const meta = {
    slug: briefRec.slug,
    brief: briefText.slice(0, 200),
    locale: briefRec.locale ?? localeFromSlug(briefRec.slug),
    startedAt,
    finishedAt,
    durationMs,
    stageDurations: lastStageDurations,
    chatModel,
    embeddingModel,
    status: isTimeout ? "timeout" : "error",
    error: msg,
    retryCount: 1,
  };
  await writeMeta(runsDir, briefRec.slug, meta);
  return meta;
}

export function buildIndexReadme(metas, { chatModel, embeddingModel, seed, generatedAt, totalDurationMs }) {
  const okCount = metas.filter((m) => m.status === "ok").length;
  const timeoutCount = metas.filter((m) => m.status === "timeout").length;
  const errorCount = metas.filter((m) => m.status === "error").length;
  const lines = [
    "# Full run",
    "",
    `- generatedAt: \`${generatedAt}\``,
    `- chatModel: \`${chatModel}\``,
    `- embeddingModel: \`${embeddingModel}\``,
    `- seed: \`${seed}\``,
    `- totalDurationMs: \`${totalDurationMs}\``,
    `- ok / timeout / error: **${okCount}** / **${timeoutCount}** / **${errorCount}**`,
    "",
    "| slug | locale | matched | gaps (none/partial) | status | duration (ms) | output |",
    "|------|--------|---------|---------------------|--------|---------------|--------|",
  ];
  for (const m of metas) {
    const matched = m.status === "ok" ? String(m.matchedFragmentCount ?? "") : "";
    const gaps = m.status === "ok"
      ? `${m.gapCounts?.none ?? 0} / ${m.gapCounts?.partial ?? 0}`
      : "";
    const link = m.status === "ok" ? `[md](./${m.slug}.md)` : "—";
    lines.push(`| \`${m.slug}\` | ${m.locale} | ${matched} | ${gaps} | ${m.status} | ${m.durationMs} | ${link} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function buildSeedSummary(corpusPath = CORPUS_PATH, now = () => Date.now()) {
  if (!existsSync(corpusPath)) {
    return { status: "not-seeded", note: "Run npm run seed -- --seed=20260626 first" };
  }
  const raw = await readFile(corpusPath, "utf8");
  const corpus = JSON.parse(raw);
  const locales = {};
  for (const f of corpus.fragments ?? []) {
    locales[f.locale] = (locales[f.locale] ?? 0) + 1;
  }
  return {
    fragmentCount: (corpus.fragments ?? []).length,
    locales,
    generatedAt: corpus.generatedAt ?? new Date(now()).toISOString(),
  };
}

async function loadStages() {
  const [{ parseBrief }, { retrieve }, { analyseGaps }, { compose }] = await Promise.all([
    import("../discovery-agent/src/pipeline/parseBrief.js"),
    import("../discovery-agent/src/pipeline/retrieve.js"),
    import("../discovery-agent/src/pipeline/analyseGaps.js"),
    import("../discovery-agent/src/pipeline/compose.js"),
  ]);
  return { parseBrief, retrieve, analyseGaps, compose };
}

export async function main({ now = () => Date.now() } = {}) {
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "error";
  await mkdir(RUNS_DIR, { recursive: true });

  const precheck = await corpusPrecheck(CORPUS_PATH);
  if (!precheck.ok) {
    process.stderr.write(
      `full-run: corpus precheck failed (${precheck.reason}). Run \`npm run seed -- --seed=${DEMO_SEED}\` first.\n`,
    );
    return 1;
  }

  const chatModel = getChatModel("default");
  const embeddingModel = getEmbeddingModel();
  const briefFiles = await listBriefs();
  const briefs = [];
  for (const b of briefFiles) {
    const text = await readFile(b.file, "utf8");
    const locale = await inferLocale(b.slug, text, EXPECTATIONS_DIR);
    briefs.push({ ...b, text, locale });
  }

  const source = new JsonFragmentSource(CORPUS_PATH);
  const stages = await loadStages();
  const { runPipeline } = await import("../discovery-agent/src/cli.js");
  const { render } = await import("../discovery-agent/src/render/markdown.js");

  const t0 = now();
  const generatedAt = new Date(now()).toISOString();
  process.stdout.write(`full-run: ${briefs.length} brief(s), chat=${chatModel}, embed=${embeddingModel}\n`);

  const metas = [];
  for (const b of briefs) {
    process.stdout.write(`  • ${b.slug} … `);
    const meta = await runBriefWithRetry(b, {
      source,
      runPipeline,
      stages,
      render,
      runsDir: RUNS_DIR,
      chatModel,
      embeddingModel,
      now,
    });
    process.stdout.write(`${meta.status} (${meta.durationMs}ms)\n`);
    metas.push(meta);
  }

  const totalDurationMs = (now() - t0) | 0;
  const readme = buildIndexReadme(metas, {
    chatModel,
    embeddingModel,
    seed: DEMO_SEED,
    generatedAt,
    totalDurationMs,
  });
  await writeFile(join(RUNS_DIR, "README.md"), `${readme}\n`, "utf8");

  const seedSummary = await buildSeedSummary(CORPUS_PATH, now);
  await writeFile(join(RUNS_DIR, "seed-summary.json"), `${JSON.stringify(seedSummary, null, 2)}\n`, "utf8");

  process.stdout.write(`full-run: done in ${totalDurationMs}ms; see runs/full-run/README.md\n`);
  return 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
