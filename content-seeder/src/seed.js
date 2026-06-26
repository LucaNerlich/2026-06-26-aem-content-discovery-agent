#!/usr/bin/env node
import mri from "mri";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import pino from "pino";
import { Corpus, EMBED_MODEL, CHAT_MODEL } from "@aemdisc/shared";
import { preflightModels } from "./preflight.js";
import { planFragments, generateFragment } from "./generate.js";
import { RESERVED_COUNT } from "./topics.js";
import { buildEmbeddingsDb } from "./embeddings.js";
import {
  aemClient,
  validateCfModel,
  resetLocales,
  pushFragments,
} from "./aem-push.js";

const DEFAULT_MODEL_PATH = "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment";
const DEFAULT_OUTPUT = "data/corpus.json";
const DEFAULT_LOCALES = "en-gb,fr-fr,de-de";
const DEFAULT_COUNT = 40;
const DEFAULT_VARIATION = "medium";
const COUNT_MIN = 1;
const COUNT_MAX = 200;
const ALLOWED_VARIATIONS = new Set(["low", "medium", "high"]);

const logger = pino({ name: "seed", level: process.env.LOG_LEVEL ?? "info" });

function parseArgs(argv) {
  const args = mri(argv, {
    string: ["output", "model", "locales", "variation"],
    boolean: ["aem-push", "reset", "dry-run", "skip-embeddings", "help"],
    default: {
      output: DEFAULT_OUTPUT,
      model: DEFAULT_MODEL_PATH,
      locales: DEFAULT_LOCALES,
      variation: DEFAULT_VARIATION,
      count: DEFAULT_COUNT,
      "aem-push": false,
      reset: false,
      "dry-run": false,
      "skip-embeddings": false,
    },
    alias: { h: "help" },
  });
  if (args.help) return { help: true };

  const count = Number(args.count);
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < COUNT_MIN || count > COUNT_MAX) {
    throw new Error(`--count must be an integer in [${COUNT_MIN}, ${COUNT_MAX}]; got ${args.count}`);
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
    modelPath: String(args.model),
    count,
    locales,
    variation: String(args.variation),
    seed,
    aemPush: !!args["aem-push"],
    reset: !!args.reset,
    dryRun: !!args["dry-run"],
    skipEmbeddings: !!args["skip-embeddings"],
  };
}

function printHelp() {
  process.stdout.write(`aemdisc-seed — generate corpus.json + embeddings.db

Options:
  --output=<path>           default data/corpus.json
  --model=<jcr-path>        default ${DEFAULT_MODEL_PATH}
  --count=<n>               fragments per locale, default ${DEFAULT_COUNT}, range ${COUNT_MIN}..${COUNT_MAX}
  --locales=<csv>           default ${DEFAULT_LOCALES}
  --variation=<low|medium|high>  default ${DEFAULT_VARIATION}
  --seed=<n>                deterministic seed, default Date.now() & 0xFFFFFFFF
  --aem-push                also POST every fragment to AEM
  --reset                   (with --aem-push) delete locale folders first
  --dry-run                 generate + log; write nothing
  --skip-embeddings         skip embedding step entirely
`);
}

function avgBodyWords(fragments) {
  if (fragments.length === 0) return 0;
  const total = fragments.reduce(
    (sum, f) => sum + f.content.split(/\s+/).filter(Boolean).length,
    0,
  );
  return Math.round(total / fragments.length);
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
      embeddings: !args.skipEmbeddings,
      aemPush: args.aemPush,
      dryRun: args.dryRun,
    },
    "seed-start",
  );

  await preflightModels({ requireEmbed: !args.skipEmbeddings });

  let aemClientInstance = null;
  if (args.aemPush) {
    aemClientInstance = aemClient();
    await validateCfModel({ client: aemClientInstance, modelPath: args.modelPath });
    if (args.reset && !args.dryRun) {
      const resetRes = await resetLocales({ client: aemClientInstance, locales: args.locales });
      logger.info({ resetRes }, "aem-reset");
    }
  }

  const plan = planFragments({ locales: args.locales, count: args.count, seed: args.seed });
  const fragments = [];
  for (const entry of plan) {
    const fragment = await generateFragment({ entry, seed: args.seed, variation: args.variation });
    fragments.push(fragment);
    logger.info(
      {
        i: entry.globalIndex,
        of: plan.length,
        id: fragment.id,
        locale: fragment.locale,
        category: fragment.category,
        reserved: entry.isReserved,
      },
      "fragment-generated",
    );
    if (args.dryRun) {
      process.stdout.write(JSON.stringify(fragment, null, 2) + "\n");
    }
  }

  const corpus = Corpus.parse({
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    model: args.modelPath,
    embeddingModel: EMBED_MODEL,
    fragments,
  });

  let embeddingsResult = null;
  const embeddingsPath = join(dirname(args.outputPath), "embeddings.db");
  if (args.dryRun) {
    logger.info({ outputPath: args.outputPath, embeddingsPath }, "dry-run: skipping writes");
  } else {
    await mkdir(dirname(args.outputPath), { recursive: true });
    await writeFile(args.outputPath, JSON.stringify(corpus, null, 2) + "\n", "utf8");
    if (!args.skipEmbeddings) {
      embeddingsResult = await buildEmbeddingsDb({ path: embeddingsPath, fragments });
      logger.info(embeddingsResult, "embeddings-built");
    }
  }

  let aemPushResult = null;
  if (args.aemPush && !args.dryRun) {
    aemPushResult = await pushFragments({
      client: aemClientInstance,
      modelPath: args.modelPath,
      fragments,
      logger,
    });
    logger.info(aemPushResult, "aem-push-complete");
  }

  const totalSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  const reservedTopicsPerLocale = Math.min(args.count, RESERVED_COUNT);
  const summary = {
    outputPath: args.outputPath,
    embeddingsPath: args.dryRun || args.skipEmbeddings ? null : embeddingsPath,
    seed: args.seed,
    perLocaleCount: args.count,
    totalFragments: fragments.length,
    totalSeconds,
    avgBodyWords: avgBodyWords(fragments),
    model: args.modelPath,
    chatModel: CHAT_MODEL,
    embeddingModel: EMBED_MODEL,
    variation: args.variation,
    reservedTopicsPerLocale,
    embeddings: embeddingsResult
      ? { count: embeddingsResult.count, durationMs: embeddingsResult.durationMs }
      : null,
    aemPush: aemPushResult
      ? {
          attempted: aemPushResult.attempted,
          succeeded: aemPushResult.succeeded,
          failed: aemPushResult.failed,
        }
      : null,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  return aemPushResult && aemPushResult.failed > 0 ? 1 : 0;
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

export { run, parseArgs, avgBodyWords };
