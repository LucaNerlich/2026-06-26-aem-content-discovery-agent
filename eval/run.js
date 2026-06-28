#!/usr/bin/env node
import { readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, chat as defaultChat, getChatModel, JsonFragmentSource } from "@aemdisc/shared";
import { parseBrief } from "../discovery-agent/src/pipeline/parseBrief.js";
import { retrieve } from "../discovery-agent/src/pipeline/retrieve.js";
import { analyseGaps } from "../discovery-agent/src/pipeline/analyseGaps.js";
import { compose } from "../discovery-agent/src/pipeline/compose.js";

// DEMO_SEED - locked seed for the corpus this harness scores against.
// Canonical corpus is seed=20260626 AND count=40 (120 fragments, 40/locale);
// count=40 is the seeder default so `npm run seed --seed=20260626` reproduces it.
// See eval/README.md. If you change the seeder, re-seed and re-hand-label the expectations.
export const DEMO_SEED = 20260626;
export const DEMO_PER_LOCALE_COUNT = 40;

// Verify the on-disk corpus was generated with the seed/count the expectations
// were labelled against. Corpus provenance is optional (older files lack it), so
// an absent stamp is a soft notice; a present-but-mismatched stamp is a loud
// warning, since the fragment ids in eval/expectations/ will not line up.
export function checkCorpusProvenance(corpus) {
  if (corpus.seed == null && corpus.perLocaleCount == null) {
    return `note: corpus has no seed/count stamp (generated before provenance was added); cannot verify it matches DEMO_SEED=${DEMO_SEED}. Re-seed with \`npm run seed --seed=${DEMO_SEED}\` to stamp it.`;
  }
  const issues = [];
  if (corpus.seed != null && corpus.seed !== DEMO_SEED) {
    issues.push(`seed=${corpus.seed} (expected ${DEMO_SEED})`);
  }
  if (corpus.perLocaleCount != null && corpus.perLocaleCount !== DEMO_PER_LOCALE_COUNT) {
    issues.push(`perLocaleCount=${corpus.perLocaleCount} (expected ${DEMO_PER_LOCALE_COUNT})`);
  }
  if (issues.length > 0) {
    return `WARNING: corpus provenance mismatch - ${issues.join(", ")}. Expectation fragment ids will not line up; re-seed with \`npm run seed --seed=${DEMO_SEED}\` or re-label.`;
  }
  return null;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BRIEFS_DIR = join(HERE, "briefs");
const EXPECT_DIR = join(HERE, "expectations");
const CORPUS_PATH = join(ROOT, "data", "corpus.json");
const LATEST_PATH = join(HERE, "latest.json");

const GAP_COSINE_THRESHOLD = 0.5;
const DEFAULT_F1_THRESHOLD = 0.6;
// Coverage agreement weight for gap pairing. A topic-matched gap whose coverage
// verdict disagrees (e.g. the model said "none" where we labelled "partial")
// earns partial credit instead of being excluded outright. weight = 1 for an
// exact match, dropping by GAP_COVERAGE_PENALTY per coverage level of distance
// (none↔partial = 1 level). This stops gap-F1 collapsing to 0 on a coverage
// flip when the topic is clearly right. Override via EVAL_GAP_COVERAGE_PENALTY.
const GAP_COVERAGE_PENALTY = Number(process.env.EVAL_GAP_COVERAGE_PENALTY ?? 0.5);
const COVERAGE_ORDINAL = { none: 0, partial: 1, full: 2 };

function coverageWeight(a, b) {
  const levels = Math.abs((COVERAGE_ORDINAL[a] ?? 0) - (COVERAGE_ORDINAL[b] ?? 0));
  return Math.max(0, 1 - GAP_COVERAGE_PENALTY * levels);
}

const round3 = (n) => Number(n.toFixed(3));
// EVAL_CHAT_MODEL env override takes precedence over config/models.json so
// graders can swap to a smaller fallback model without editing the config.
// Falls back to the config "eval" stage, which itself falls back to chat.default.
const EVAL_CHAT_MODEL = process.env.EVAL_CHAT_MODEL || getChatModel("eval");

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

// The seeder produces many near-identical fragments per topic (e.g. several
// "Summer linen essentials" pieces with cosmetic title suffixes). Which exact
// duplicate retrieval picks shifts run-to-run because parseBrief is an LLM stage,
// so exact-id scoring is noisy. We score on a topic key (locale + base title)
// instead: a returned fragment counts as a hit if it shares a topic with an
// expected one. titleFor() appends one of these cosmetic suffixes.
const TITLE_SUFFIXES = [" - collection notes", " - editorial", " - guide"];

export function topicKeyOf(fragment) {
  let title = fragment.title ?? "";
  for (const suffix of TITLE_SUFFIXES) {
    if (title.endsWith(suffix)) {
      title = title.slice(0, -suffix.length);
      break;
    }
  }
  return `${fragment.locale}::${title}`;
}

export async function buildIdToTopicKey(corpusPath) {
  const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
  const map = new Map();
  for (const f of corpus.fragments ?? []) map.set(f.id, topicKeyOf(f));
  return map;
}

function precisionRecall(returnedIds, expectedIds, idToTopicKey) {
  // Map ids → topic keys (unknown ids fall back to the raw id) and dedupe,
  // so duplicate-topic fragments collapse to a single comparable unit.
  const toKeys = (ids) => [...new Set(ids.map((id) => idToTopicKey.get(id) ?? id))];
  const r = toKeys(returnedIds);
  const e = toKeys(expectedIds);
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

  // Greedy best-cosine pairing per expected gap on TOPIC similarity alone.
  // Coverage no longer gates pairing; a coverage mismatch is penalised below.
  const usedReturned = new Set();
  const pairs = [];
  for (let i = 0; i < expectedGaps.length; i += 1) {
    let bestJ = -1;
    let bestSim = -1;
    for (let j = 0; j < returnedGaps.length; j += 1) {
      if (usedReturned.has(j)) continue;
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
        expectedCoverage: expectedGaps[i].coverage,
        returnedCoverage: returnedGaps[bestJ].coverage,
        coverageWeight: coverageWeight(returnedGaps[bestJ].coverage, expectedGaps[i].coverage),
        cosine: Number(bestSim.toFixed(3)),
      });
    }
  }
  // Soft counts: each pair contributes its coverage weight to tp; the shortfall
  // (1 - weight) is charged to BOTH fp and fn. Unpaired gaps are full fp / fn.
  // With exact-coverage pairs (weight 1) this is identical to the old hard gate.
  const matched = pairs.length;
  const tp = pairs.reduce((s, p) => s + p.coverageWeight, 0);
  const shortfall = pairs.reduce((s, p) => s + (1 - p.coverageWeight), 0);
  const fp = returnedGaps.length - matched + shortfall;
  const fn = expectedGaps.length - matched + shortfall;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  return { f1: f1FromCounts(tp, fp, fn), precision, recall, tp: round3(tp), fp: round3(fp), fn: round3(fn), pairs };
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
      // Briefs without matching expectations are reusable by the full-run harness
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
  const corpus = JSON.parse(await readFile(CORPUS_PATH, "utf8"));
  const provenanceMsg = checkCorpusProvenance(corpus);
  if (provenanceMsg) process.stderr.write(`${provenanceMsg}\n\n`);
  const idToTopicKey = await buildIdToTopicKey(CORPUS_PATH);
  const chatFn = makeChat(EVAL_CHAT_MODEL);
  process.stdout.write(
    `Eval harness - DEMO_SEED=${DEMO_SEED}, corpus=${CORPUS_PATH}\n` +
      `chat=${EVAL_CHAT_MODEL}, gap cosine ≥ ${GAP_COSINE_THRESHOLD}, coverage penalty = ${GAP_COVERAGE_PENALTY}, F1 threshold = ${threshold}\n` +
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
      process.stdout.write(`× ${brief.name} - pipeline error (${durationMs}ms)\n  ${error.split("\n")[0]}\n\n`);
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
    const pr = precisionRecall(returnedIds, brief.expect.expectedMatchIds ?? [], idToTopicKey);
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
      returnedTopics: [...new Set(returnedIds.map((id) => idToTopicKey.get(id) ?? id))],
      expectedTopics: [...new Set((brief.expect.expectedMatchIds ?? []).map((id) => idToTopicKey.get(id) ?? id))],
      returnedGaps: output.gaps.map((g) => ({ topic: g.topic, coverage: g.coverage })),
      expectedGaps: brief.expect.expectedGaps ?? [],
    });

    const composeNote = output.composeError ? "  (compose draftOutline rejected - metrics computed from retrieval+gaps)\n" : "";
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
    gapCoveragePenalty: GAP_COVERAGE_PENALTY,
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
