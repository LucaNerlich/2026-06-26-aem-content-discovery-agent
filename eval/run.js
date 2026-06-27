#!/usr/bin/env node
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, chat as defaultChat, getChatModel, JsonFragmentSource } from "@aemdisc/shared";
import { parseBrief } from "../discovery-agent/src/pipeline/parseBrief.js";
import { retrieve } from "../discovery-agent/src/pipeline/retrieve.js";
import { analyseGaps } from "../discovery-agent/src/pipeline/analyseGaps.js";
import { compose } from "../discovery-agent/src/pipeline/compose.js";

// DEMO_SEED — locked seed for the corpus this harness scores against.
// See eval/README.md. If you change the seeder, re-run
// `npm run seed -- --seed=20260626` and re-hand-label the expectations.
export const DEMO_SEED = 20260626;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BRIEFS_DIR = join(HERE, "briefs");
const EXPECT_DIR = join(HERE, "expectations");
const CORPUS_PATH = join(ROOT, "data", "corpus.json");
const LATEST_PATH = join(HERE, "latest.json");

const GAP_COSINE_THRESHOLD = 0.7;
const DEFAULT_F1_THRESHOLD = 0.6;
// EVAL_CHAT_MODEL env override takes precedence over config/models.json so
// graders can swap to a smaller fallback model without editing the config.
const EVAL_CHAT_MODEL = process.env.EVAL_CHAT_MODEL || getChatModel("default");

// Wrap shared.chat so every pipeline stage uses EVAL_CHAT_MODEL by default.
// Lets graders point the harness at a smaller local model when the default
// (qwen3.5:9b, or gemma4:26b as a premium alternative) is impractical,
// without modifying the agent's runtime defaults.
function makeChat(model) {
  return (opts = {}) => defaultChat({ ...opts, model: opts.model ?? model });
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function setIntersect(a, b) {
  const sb = new Set(b);
  let n = 0;
  for (const x of a) if (sb.has(x)) n += 1;
  return n;
}

function precisionRecall(returnedIds, expectedIds) {
  const r = [...new Set(returnedIds)];
  const e = [...new Set(expectedIds)];
  const tp = setIntersect(r, e);
  const precision = r.length === 0 ? (e.length === 0 ? 1 : 0) : tp / r.length;
  const recall = e.length === 0 ? 1 : tp / e.length;
  return { precision, recall, tp, returned: r.length, expected: e.length };
}

function f1FromCounts(tp, fp, fn) {
  if (tp === 0 && fp === 0 && fn === 0) return 1;
  if (tp === 0) return 0;
  const p = tp / (tp + fp);
  const r = tp / (tp + fn);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
}

async function gapF1(returnedGaps, expectedGaps) {
  if (returnedGaps.length === 0 && expectedGaps.length === 0) {
    return { f1: 1, precision: 1, recall: 1, tp: 0, fp: 0, fn: 0, pairs: [] };
  }
  const returnedTopics = returnedGaps.map((g) => g.topic);
  const expectedTopics = expectedGaps.map((g) => g.topicLabel);
  const allTexts = [...returnedTopics, ...expectedTopics];
  const vectors = allTexts.length > 0 ? await embed(allTexts) : [];
  const rVecs = vectors.slice(0, returnedTopics.length);
  const eVecs = vectors.slice(returnedTopics.length);

  // Greedy best-cosine pairing per expected gap, gated by same coverage.
  const usedReturned = new Set();
  const pairs = [];
  for (let i = 0; i < expectedGaps.length; i += 1) {
    let bestJ = -1;
    let bestSim = -1;
    for (let j = 0; j < returnedGaps.length; j += 1) {
      if (usedReturned.has(j)) continue;
      if (returnedGaps[j].coverage !== expectedGaps[i].coverage) continue;
      const sim = cosine(eVecs[i], rVecs[j]);
      if (sim > bestSim) {
        bestSim = sim;
        bestJ = j;
      }
    }
    if (bestJ >= 0 && bestSim >= GAP_COSINE_THRESHOLD) {
      usedReturned.add(bestJ);
      pairs.push({
        expected: expectedGaps[i].topicLabel,
        returned: returnedGaps[bestJ].topic,
        coverage: expectedGaps[i].coverage,
        cosine: Number(bestSim.toFixed(3)),
      });
    }
  }
  const tp = pairs.length;
  const fp = returnedGaps.length - tp;
  const fn = expectedGaps.length - tp;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { f1: f1FromCounts(tp, fp, fn), precision, recall, tp, fp, fn, pairs };
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

async function listBriefFiles() {
  const entries = await readdir(BRIEFS_DIR);
  return entries
    .filter((f) => f.endsWith(".txt"))
    .map((f) => ({ name: basename(f, ".txt"), file: join(BRIEFS_DIR, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadBriefSet() {
  const briefs = await listBriefFiles();
  const out = [];
  const skipped = [];
  for (const b of briefs) {
    const text = await readFile(b.file, "utf8");
    const expectFile = join(EXPECT_DIR, `${b.name}.json`);
    let expect;
    try {
      expect = JSON.parse(await readFile(expectFile, "utf8"));
    } catch (err) {
      // Briefs without matching expectations are reusable by the alpha runner
      // but cannot be scored here; warn and skip rather than aborting the eval.
      if (err.code === "ENOENT") {
        skipped.push(b.name);
        continue;
      }
      throw new Error(`Failed to read expectations for brief "${b.name}" (${expectFile}): ${err.message}`);
    }
    out.push({ name: b.name, text, expect });
  }
  if (skipped.length > 0) {
    process.stderr.write(
      `warn: skipping ${skipped.length} brief(s) without expectations: ${skipped.join(", ")}\n`,
    );
  }
  return out;
}

async function runOne(brief, chatFn) {
  const source = new JsonFragmentSource(CORPUS_PATH);
  let structured = await parseBrief(brief.text, { chat: chatFn, model: EVAL_CHAT_MODEL });
  if (brief.expect.localeOverride) {
    structured = { ...structured, locale: brief.expect.localeOverride };
  }
  const retrieval = await retrieve(structured, { source, k: 3 });
  const gaps = await analyseGaps(structured, retrieval, { chat: chatFn, model: EVAL_CHAT_MODEL });
  // matchedFragments are deterministically derived from retrieval inside compose;
  // mirror that shape here so a compose failure still produces eval metrics.
  const matchedFragments = retrieval.matches.map((m) => ({
    id: m.fragment.id,
    path: m.fragment.path ?? "",
    score: m.score,
    reason: m.reason,
  }));
  let composeError;
  try {
    await compose(structured, retrieval, gaps, { chat: chatFn, model: EVAL_CHAT_MODEL });
  } catch (err) {
    composeError = err?.message ?? String(err);
  }
  return { brief: structured, matchedFragments, gaps, composeError };
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(3) : "n/a";
}

async function main() {
  if (!process.env.LOG_LEVEL) process.env.LOG_LEVEL = "error";
  const threshold = Number(process.env.EVAL_F1_THRESHOLD ?? DEFAULT_F1_THRESHOLD);
  const briefs = await loadBriefSet();
  const chatFn = makeChat(EVAL_CHAT_MODEL);
  process.stdout.write(
    `Eval harness — DEMO_SEED=${DEMO_SEED}, corpus=${CORPUS_PATH}\n` +
      `chat=${EVAL_CHAT_MODEL}, gap cosine ≥ ${GAP_COSINE_THRESHOLD}, F1 threshold = ${threshold}\n` +
      `${briefs.length} brief(s):\n\n`,
  );

  const perBrief = [];
  for (const brief of briefs) {
    const startedAt = Date.now();
    let output;
    let error;
    try {
      output = await runOne(brief, chatFn);
    } catch (err) {
      error = err?.stack ?? String(err);
    }
    const durationMs = Date.now() - startedAt;

    if (error) {
      process.stdout.write(`× ${brief.name} — pipeline error (${durationMs}ms)\n  ${error.split("\n")[0]}\n\n`);
      perBrief.push({
        name: brief.name,
        durationMs,
        error,
        precision: 0,
        recall: 0,
        gap: { f1: 0, precision: 0, recall: 0, tp: 0, fp: 0, fn: 0, pairs: [] },
      });
      continue;
    }

    const returnedIds = output.matchedFragments.map((m) => m.id);
    const pr = precisionRecall(returnedIds, brief.expect.expectedMatchIds ?? []);
    const gap = await gapF1(output.gaps, brief.expect.expectedGaps ?? []);

    perBrief.push({
      name: brief.name,
      durationMs,
      precision: pr.precision,
      recall: pr.recall,
      gap,
      composeError: output.composeError ?? null,
      returnedMatchIds: returnedIds,
      expectedMatchIds: brief.expect.expectedMatchIds ?? [],
      returnedGaps: output.gaps.map((g) => ({ topic: g.topic, coverage: g.coverage })),
      expectedGaps: brief.expect.expectedGaps ?? [],
    });

    const composeNote = output.composeError ? "  (compose draftOutline rejected — metrics computed from retrieval+gaps)\n" : "";
    process.stdout.write(
      `• ${brief.name} (${(durationMs / 1000).toFixed(1)}s)\n` +
        `    precision@3=${fmt(pr.precision)} recall@3=${fmt(pr.recall)} ` +
        `(${pr.tp}/${pr.returned} returned, ${pr.tp}/${pr.expected} expected)\n` +
        `    gap-F1=${fmt(gap.f1)} (P=${fmt(gap.precision)} R=${fmt(gap.recall)} ` +
        `tp=${gap.tp} fp=${gap.fp} fn=${gap.fn})\n${composeNote}\n`,
    );
  }

  const aggregate = {
    precision: mean(perBrief.map((b) => b.precision)),
    recall: mean(perBrief.map((b) => b.recall)),
    gapF1: mean(perBrief.map((b) => b.gap.f1)),
  };
  process.stdout.write(
    `aggregate (mean of ${perBrief.length}):\n` +
      `    precision@3=${fmt(aggregate.precision)} recall@3=${fmt(aggregate.recall)} gap-F1=${fmt(aggregate.gapF1)}\n` +
      `    threshold (gap-F1) = ${threshold} → ${aggregate.gapF1 >= threshold ? "PASS" : "FAIL"}\n`,
  );

  const summary = {
    schemaVersion: "1.0",
    demoSeed: DEMO_SEED,
    corpusPath: CORPUS_PATH,
    chatModel: EVAL_CHAT_MODEL,
    gapCosineThreshold: GAP_COSINE_THRESHOLD,
    f1Threshold: threshold,
    ranAt: new Date().toISOString(),
    aggregate,
    perBrief,
  };
  await writeFile(LATEST_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  process.exit(aggregate.gapF1 >= threshold ? 0 : 1);
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
