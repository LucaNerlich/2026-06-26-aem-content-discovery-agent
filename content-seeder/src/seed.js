#!/usr/bin/env node
import mri from "mri";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import pino from "pino";
import { Corpus, getChatModel, getEmbeddingModel } from "@aemdisc/shared";
import { preflightModels } from "./preflight.js";
import { planFragments, generateFragment } from "./generate.js";
import { RESERVED_COUNT } from "./topics.js";
import { buildEmbeddingsDb } from "./embeddings.js";

const DEFAULT_OUTPUT = new URL("../../data/corpus.json", import.meta.url).pathname;
const DEFAULT_LOCALES = "en-gb,fr-fr,de-de";
// Canonical corpus size: 200 per locale (600 total) is the frozen snapshot the
// eval expectations are hand-labelled against. Changing this invalidates fragment
// ids in eval/expectations/ — re-label if you change it. See eval/run.js DEMO_SEED.
const DEFAULT_COUNT = 200;
const DEFAULT_VARIATION = "medium";
const DEFAULT_CONCURRENCY = 4;
const COUNT_MIN = 1;
const COUNT_MAX = 200;
const ALLOWED_VARIATIONS = new Set(["low", "medium", "high"]);

const logger = pino({ name: "seed", level: process.env.LOG_LEVEL ?? "info" });

function parseArgs(argv) {
  // pnpm prepends an extra "--" when forwarding args through nested npm-run scripts.
  // Strip it so mri doesn't treat the real flags as positional args.
  const cleaned = argv[0] === "--" ? argv.slice(1) : argv;
  const args = mri(cleaned, {
    string: ["output", "locales", "variation"],
    boolean: ["dry-run", "skip-embeddings", "help"],
    default: {
      output: DEFAULT_OUTPUT,
      locales: DEFAULT_LOCALES,
      variation: DEFAULT_VARIATION,
      count: DEFAULT_COUNT,
      concurrency: DEFAULT_CONCURRENCY,
      "dry-run": false,
      "skip-embeddings": true,
    },
    alias: { h: "help" },
  });
  if (args.help) return { help: true };

  const count = Number(args.count);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < COUNT_MIN || count > COUNT_MAX) {
    throw new Error(`--count must be an integer in [${COUNT_MIN}, ${COUNT_MAX}]; got ${args.count}`);
  }
  const concurrency = Number(args.concurrency);
  if (!Number.isFinite(concurrency) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new Error(`--concurrency must be an integer in [1, 16]; got ${args.concurrency}`);
  }
  if (!ALLOWED_VARIATIONS.has(args.variation)) {
    throw new Error(`--variation must be one of low|medium|high; got ${args.variation}`);
  }
  const locales = String(args.locales).split(",").map((s) => s.trim()).filter(Boolean);
  if (locales.length === 0) throw new Error("--locales must include at least one locale");
  const seed = args.seed !== undefined
    ? (Number(args.seed) >>> 0)
    : (Date.now() & 0xFFFFFFFF) >>> 0;

  return {
    help: false,
    outputPath: resolve(String(args.output)),
    count,
    concurrency,
    locales,
    variation: String(args.variation),
    seed,
    dryRun: !!args["dry-run"],
    skipEmbeddings: !!args["skip-embeddings"],
  };
}

function printHelp() {
  process.stdout.write(`aemdisc-seed — generate corpus.json (Step 1 of 2)

Options:
  --output=<path>                default data/corpus.json
  --count=<n>                    fragments per locale, default ${DEFAULT_COUNT}, range ${COUNT_MIN}..${COUNT_MAX}
  --locales=<csv>                default ${DEFAULT_LOCALES}
  --variation=<low|medium|high>  default ${DEFAULT_VARIATION}
  --concurrency=<n>              parallel LLM calls, default ${DEFAULT_CONCURRENCY}
  --seed=<n>                     deterministic seed, default Date.now() & 0xFFFFFFFF
  --dry-run                      generate + log; write nothing
  --skip-embeddings              skip embedding step (default: true); use 'npm run embed' separately

Step 2: npm run embed -- --corpus=data/corpus.json --db=data/embeddings.db
`);
}

export function avgBodyWords(fragments) {
  if (fragments.length === 0) return 0;
  const total = fragments.reduce(
    (sum, f) => sum + f.content.split(/\s+/).filter(Boolean).length,
    0,
  );
  return Math.round(total / fragments.length);
}

async function saveCorpus(outputPath, fragments) {
  const corpus = Corpus.parse({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    model: getChatModel("seeder"),
    embeddingModel: getEmbeddingModel(),
    fragments,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(corpus, null, 2) + "\n", "utf8");
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  const startedAt = Date.now();
  logger.info(
    {
      seed: args.seed,
      count: args.count,
      locales: args.locales,
      variation: args.variation,
      concurrency: args.concurrency,
      embeddings: !args.skipEmbeddings,
      dryRun: args.dryRun,
    },
    "seed-start",
  );

  await preflightModels({ requireEmbed: !args.skipEmbeddings });

  const plan = planFragments({ locales: args.locales, count: args.count, seed: args.seed });
  const fragments = [];
  const embeddingsPath = join(dirname(args.outputPath), "embeddings.db");

  // Generate in parallel batches; failures are logged but don't kill the run.
  for (let batchStart = 0; batchStart < plan.length; batchStart += args.concurrency) {
    const batch = plan.slice(batchStart, batchStart + args.concurrency);
    const results = await Promise.allSettled(
      batch.map((entry) => generateFragment({ entry, seed: args.seed, variation: args.variation })),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const entry = batch[j];
      if (result.status === "fulfilled") {
        const fragment = result.value;
        fragments.push(fragment);
        logger.info(
          { i: entry.globalIndex, of: plan.length, id: fragment.id, locale: fragment.locale, category: fragment.category, reserved: entry.isReserved },
          "fragment-generated",
        );
        if (args.dryRun) process.stdout.write(JSON.stringify(fragment, null, 2) + "\n");
      } else {
        const err = result.reason;
        logger.error(
          { i: entry.globalIndex, of: plan.length, locale: entry.locale, errorClass: err.name, err: err.message },
          "fragment-failed",
        );
      }
    }

    // Incremental checkpoint: save what we have so far after each batch.
    if (!args.dryRun && fragments.length > 0) {
      await saveCorpus(args.outputPath, fragments);
      logger.info({ saved: fragments.length, total: plan.length }, "corpus-checkpoint");
    }
  }

  let embeddingsResult = null;
  if (args.dryRun) {
    logger.info({ outputPath: args.outputPath }, "dry-run complete");
  } else if (!args.skipEmbeddings && fragments.length > 0) {
    embeddingsResult = await buildEmbeddingsDb({ path: embeddingsPath, fragments });
    logger.info(embeddingsResult, "embeddings-built");
  }

  const totalSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  const summary = {
    outputPath: args.dryRun ? null : args.outputPath,
    embeddingsPath: args.dryRun || args.skipEmbeddings ? null : embeddingsPath,
    seed: args.seed,
    perLocaleCount: args.count,
    totalFragments: fragments.length,
    failedFragments: plan.length - fragments.length,
    totalSeconds,
    avgBodyWords: avgBodyWords(fragments),
    chatModel: getChatModel("seeder"),
    embeddingModel: getEmbeddingModel(),
    variation: args.variation,
    concurrency: args.concurrency,
    reservedTopicsPerLocale: Math.min(args.count, RESERVED_COUNT),
    embeddings: embeddingsResult
      ? { count: embeddingsResult.count, durationMs: embeddingsResult.durationMs }
      : null,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  return 0;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error({ err: err.message, errorClass: err.name }, "seed-failed");
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    });
}

export { run, parseArgs };
