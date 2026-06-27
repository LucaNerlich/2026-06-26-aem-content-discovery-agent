#!/usr/bin/env node
/**
 * Step 2: embed corpus.json into embeddings.db
 *
 * Usage: npm run embed [-- --corpus=data/corpus.json --db=data/embeddings.db]
 */
import mri from "mri";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pino from "pino";
import { Corpus } from "@aemdisc/shared";
import { buildEmbeddingsDb } from "./embeddings.js";

const DEFAULT_CORPUS = "data/corpus.json";
const DEFAULT_DB = "data/embeddings.db";

const logger = pino({ name: "embed", level: process.env.LOG_LEVEL ?? "info" });

function parseArgs(argv) {
  const args = mri(argv, {
    string: ["corpus", "db"],
    boolean: ["help"],
    default: { corpus: DEFAULT_CORPUS, db: DEFAULT_DB },
    alias: { h: "help" },
  });
  if (args.help) return { help: true };
  return {
    help: false,
    corpusPath: resolve(String(args.corpus)),
    dbPath: resolve(String(args.db)),
  };
}

function printHelp() {
  process.stdout.write(`aemdisc-embed — embed corpus.json into SQLite vector store (Step 2 of 2)

Options:
  --corpus=<path>  path to corpus.json   default: ${DEFAULT_CORPUS}
  --db=<path>      path to embeddings.db default: ${DEFAULT_DB}

Example:
  npm run embed
  npm run embed -- --corpus=data/corpus.json --db=data/embeddings.db
`);
}

async function run(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  logger.info({ corpusPath: args.corpusPath, dbPath: args.dbPath }, "embed-start");

  let raw;
  try {
    raw = JSON.parse(await readFile(args.corpusPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to read corpus: ${err.message} (path: ${args.corpusPath})`);
  }

  const corpus = Corpus.parse(raw);
  if (corpus.fragments.length === 0) {
    logger.warn("corpus contains no fragments — nothing to embed");
    return 0;
  }

  logger.info({ fragments: corpus.fragments.length }, "corpus-loaded");

  const result = await buildEmbeddingsDb({ path: args.dbPath, fragments: corpus.fragments });

  logger.info(result, "embed-complete");
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error({ err: err.message }, "embed-failed");
      process.stderr.write(`\n${err.message}\n`);
      process.exit(1);
    });
}

export { run, parseArgs };
