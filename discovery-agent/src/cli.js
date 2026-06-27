#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import mri from "mri";
import { persistAgentArtifact, slugFromBriefPath } from "./persistResult.js";

// When run via `npm run -w discovery-agent`, process.cwd() is discovery-agent/.
// INIT_CWD is set by npm to the directory where the root `npm run` was invoked.
const REPO_ROOT = process.env.INIT_CWD ?? resolve(new URL("../..", import.meta.url).pathname);

function resolveFromRoot(p) {
  return resolve(REPO_ROOT, p);
}

const HELP = `Usage: aemdisc-agent [brief.txt] [options]

Reads a content brief (file arg or stdin), runs the discovery pipeline, and
renders the result. Defaults to Markdown; use --json for the raw AgentOutput.

Options:
  --json                 Emit canonical AgentOutput JSON instead of Markdown
  --locale=<code>        Override the locale auto-detected from the brief
  --quiet                Suppress pino progress logs on stderr
  --top=<n>              Debug override of matched-fragments k (default 3, max 10)
  --source=json|aem      Fragment source (default: json)
  --corpus=<path>        Corpus JSON path when --source=json (default: data/corpus.json)
  --results-dir=<path>   Directory for timestamped result artifacts (default: runs/agent)
  -h, --help             Show this help

On success the rendered output is also written to a timestamped file under
the results directory: <ISO-timestamp>-<brief-slug>.<md|json>.

Exit codes: 0 success; 1 pipeline/validation error; 2 input error.`;

export function parseArgs(argv) {
  return mri(argv, {
    boolean: ["json", "quiet", "help"],
    string: ["locale", "source", "corpus", "results-dir"],
    alias: { h: "help" },
    default: { source: "json", corpus: "data/corpus.json" },
  });
}

async function readStdin(stdin = process.stdin) {
  if (stdin.isTTY) return "";
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data;
}

async function loadBrief(args, stdin) {
  const briefArg = args._[0];
  if (briefArg) {
    // Resolve relative paths against INIT_CWD (where `npm run` was invoked) so
    // workspace-scoped execution doesn't silently shift the base to discovery-agent/.
    const base = process.env.INIT_CWD ?? process.cwd();
    const path = resolve(base, String(briefArg));
    try {
      const text = await readFile(path, "utf8");
      if (text.trim().length === 0) return { error: `Brief file is empty: ${path}` };
      return { text };
    } catch (err) {
      if (err.code === "ENOENT") return { error: `Brief file not found: ${path}` };
      return { error: `Failed to read brief: ${err.message}` };
    }
  }
  const stdinText = await readStdin(stdin);
  if (stdinText.trim().length === 0) {
    return { error: "No brief provided: pass a file path or pipe text via stdin" };
  }
  return { text: stdinText };
}

async function buildSource(args) {
  const kind = args.source;
  if (kind === "json") {
    const { JsonFragmentSource } = await import("@aemdisc/shared");
    return new JsonFragmentSource(resolveFromRoot(args.corpus));
  }
  if (kind === "aem") {
    const { AemFragmentSource, createAemClient } = await import("@aemdisc/shared");
    return new AemFragmentSource(createAemClient());
  }
  throw new Error(`Unknown --source value: "${kind}" (expected json|aem)`);
}

function resolveTopK(args) {
  if (args.top === undefined || args.top === null || args.top === "") return 3;
  const n = Number(args.top);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new Error(`--top must be an integer between 1 and 10 (got "${args.top}")`);
  }
  return n;
}

export async function runPipeline(briefText, { source, k, localeOverride, vectorDbPath } = {}, deps = {}) {
  const { parseBrief } = deps.parseBrief
    ? { parseBrief: deps.parseBrief }
    : await import("./pipeline/parseBrief.js");
  const { retrieve } = deps.retrieve
    ? { retrieve: deps.retrieve }
    : await import("./pipeline/retrieve.js");
  const { analyseGaps } = deps.analyseGaps
    ? { analyseGaps: deps.analyseGaps }
    : await import("./pipeline/analyseGaps.js");
  const { compose } = deps.compose
    ? { compose: deps.compose }
    : await import("./pipeline/compose.js");

  let brief = await parseBrief(briefText);
  if (localeOverride) brief = { ...brief, locale: localeOverride };
  const retrieval = await retrieve(brief, { source, k, ...(vectorDbPath ? { vectorDbPath } : {}) });
  const gaps = await analyseGaps(brief, retrieval);
  return compose(brief, retrieval, gaps);
}

export async function main({
  argv = process.argv.slice(2),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  deps,
  now = () => Date.now(),
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${HELP}\n`);
    return 0;
  }
  if (args.quiet) process.env.LOG_LEVEL = "silent";

  const briefRes = await loadBrief(args, stdin);
  if (briefRes.error) {
    stderr.write(`error: ${briefRes.error}\n`);
    return 2;
  }

  let k;
  let source;
  try {
    k = resolveTopK(args);
    source = await buildSource(args);
  } catch (err) {
    stderr.write(`error: ${err.message}\n`);
    return 2;
  }

  let output;
  try {
    output = await runPipeline(
      briefRes.text,
      { source, k, localeOverride: args.locale, vectorDbPath: resolveFromRoot("data/embeddings.db") },
      deps,
    );
  } catch (err) {
    stderr.write(`pipeline error: ${err?.message ?? err}\n`);
    if (process.env.LOG_LEVEL !== "silent" && err?.stack) stderr.write(`${err.stack}\n`);
    return 1;
  }

  let rendered;
  if (args.json) {
    rendered = `${JSON.stringify(output, null, 2)}\n`;
  } else {
    const { render } = await import("./render/markdown.js");
    rendered = `${render(output)}\n`;
  }
  stdout.write(rendered);

  const format = args.json ? "json" : "md";
  const resultsDir = args["results-dir"]
    ? resolve(process.env.INIT_CWD ?? process.cwd(), String(args["results-dir"]))
    : resolveFromRoot("runs/agent");
  const slug = slugFromBriefPath(args._[0]);
  try {
    const written = await persistAgentArtifact({
      dir: resultsDir,
      slug,
      format,
      content: rendered,
      now: now(),
    });
    if (!args.quiet && process.env.LOG_LEVEL !== "silent") {
      stderr.write(`saved: ${written}\n`);
    }
  } catch (err) {
    stderr.write(`warning: failed to persist result artifact: ${err?.message ?? err}\n`);
  }

  return 0;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
