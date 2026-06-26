import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { AgentOutput } from "@aemdisc/shared";
import { parseArgs, runPipeline, main } from "../src/cli.js";

function makeWritable() {
  let buf = "";
  const w = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  Object.defineProperty(w, "text", { get: () => buf });
  return w;
}

function ttyReadable() {
  const r = Readable.from([]);
  r.isTTY = true;
  return r;
}

function stdinFromString(s) {
  const r = Readable.from([s]);
  r.isTTY = false;
  return r;
}

const brief = {
  audience: "UK shoppers", locale: "en-gb", tone: "premium",
  brandGuidelines: ["premium-tone"], requiredTopics: ["a", "b"],
  pathHint: "/en-gb/x",
};
const retrieval = {
  matches: [
    { fragment: { id: "frag_001", path: "/p/1", title: "T1", content: "..." }, score: 0.8, breakdown: {}, reason: "match" },
  ],
  nearMisses: [], droppedByBrandFilter: [], localeRelaxed: false, vectorSearchAvailable: true,
};
const fixtureOutput = {
  schemaVersion: "1.0",
  brief,
  matchedFragments: [{ id: "frag_001", path: "/p/1", score: 0.8, reason: "match" }],
  gaps: [{ topic: "b", coverage: "none", description: "missing", partialMatches: [], suggestedAction: "write it" }],
  draftOutline: {
    title: "T", pathHint: "/en-gb/x",
    sections: [
      { heading: "Intro", kind: "reuse", fragmentIds: ["frag_001"], rationale: "r" },
      { heading: "New", kind: "new", rationale: "r", sourcingHint: "s" },
    ],
  },
};

const mockDeps = {
  parseBrief: async () => brief,
  retrieve: async () => retrieval,
  analyseGaps: async () => fixtureOutput.gaps,
  compose: async () => fixtureOutput,
};

test("parseArgs: defaults source=json, corpus=data/corpus.json", () => {
  const a = parseArgs([]);
  assert.equal(a.source, "json");
  assert.equal(a.corpus, "data/corpus.json");
  assert.ok(!a.json);
  assert.ok(!a.quiet);
});

test("parseArgs: --json --quiet --locale --top --source --corpus parse", () => {
  const a = parseArgs(["brief.txt", "--json", "--quiet", "--locale=de-de", "--top=5", "--source=aem", "--corpus=x.json"]);
  assert.equal(a.json, true);
  assert.equal(a.quiet, true);
  assert.equal(a.locale, "de-de");
  assert.equal(a.top, 5);
  assert.equal(a.source, "aem");
  assert.equal(a.corpus, "x.json");
  assert.equal(a._[0], "brief.txt");
});

test("runPipeline: round-trips through AgentOutput.parse via mocked stages", async () => {
  const out = await runPipeline("any brief", { source: { kind: "stub" } }, mockDeps);
  assert.doesNotThrow(() => AgentOutput.parse(out));
  assert.equal(out.brief.locale, "en-gb");
});

test("runPipeline: localeOverride wins over parsed locale (but pipeline mock receives override)", async () => {
  let seenLocale;
  const deps = {
    ...mockDeps,
    retrieve: async (b) => {
      seenLocale = b.locale;
      return retrieval;
    },
  };
  await runPipeline("any brief", { source: { kind: "stub" }, localeOverride: "fr-fr" }, deps);
  assert.equal(seenLocale, "fr-fr");
});

test("main: missing brief file returns exit code 2", async () => {
  const stderr = makeWritable();
  const code = await main({
    argv: ["/no/such/file.txt"],
    stdin: ttyReadable(),
    stdout: makeWritable(),
    stderr,
  });
  assert.equal(code, 2);
  assert.match(stderr.text, /Brief file not found/);
});

test("main: empty stdin returns exit code 2", async () => {
  const stderr = makeWritable();
  const code = await main({
    argv: [],
    stdin: stdinFromString("   \n"),
    stdout: makeWritable(),
    stderr,
  });
  assert.equal(code, 2);
  assert.match(stderr.text, /No brief provided/);
});

test("main: invalid --top returns exit code 2", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-test-"));
  try {
    const briefPath = join(dir, "brief.txt");
    await writeFile(briefPath, "hello world");
    const stderr = makeWritable();
    const code = await main({
      argv: [briefPath, "--top=99"],
      stdin: ttyReadable(),
      stdout: makeWritable(),
      stderr,
    });
    assert.equal(code, 2);
    assert.match(stderr.text, /--top must be an integer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main: --help prints usage and exits 0", async () => {
  const stdout = makeWritable();
  const code = await main({
    argv: ["--help"],
    stdin: ttyReadable(),
    stdout,
    stderr: makeWritable(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text, /Usage: aemdisc-agent/);
});
