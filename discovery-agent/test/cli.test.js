import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

import { AgentOutput } from "@aemdisc/shared";
import { parseArgs, runPipeline, main } from "../src/cli.js";
import {
  buildArtifactFilename,
  persistAgentArtifact,
  slugFromBriefPath,
  slugify,
  timestampForFilename,
} from "../src/persistResult.js";

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
  assert.match(stdout.text, /--results-dir/);
});

test("timestampForFilename: replaces colons and dots so the result is fs-safe", () => {
  const fixed = Date.UTC(2026, 5, 27, 14, 20, 58, 461);
  assert.equal(timestampForFilename(fixed), "2026-06-27T14-20-58-461Z");
});

test("slugify: collapses unsafe characters and clamps length", () => {
  assert.equal(slugify("winter-sustainable"), "winter-sustainable");
  assert.equal(slugify("a b/c?d"), "a-b-c-d");
  assert.equal(slugify(""), "stdin");
  assert.equal(slugify(undefined), "stdin");
  assert.equal(slugify("a".repeat(200)).length, 80);
});

test("slugFromBriefPath: strips directory and extension", () => {
  assert.equal(slugFromBriefPath("eval/briefs/winter-sustainable.txt"), "winter-sustainable");
  assert.equal(slugFromBriefPath("/abs/path/de-de-workwear-tech.txt"), "de-de-workwear-tech");
  assert.equal(slugFromBriefPath(undefined), "stdin");
});

test("buildArtifactFilename: composes <iso>-<slug>.<ext>", () => {
  const fixed = Date.UTC(2026, 5, 27, 14, 20, 58, 461);
  assert.equal(
    buildArtifactFilename({ slug: "winter-sustainable", ext: "md", now: fixed }),
    "2026-06-27T14-20-58-461Z-winter-sustainable.md",
  );
  assert.throws(() => buildArtifactFilename({ slug: "x", ext: "txt" }));
});

test("persistAgentArtifact: writes Markdown content with .md extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persist-md-"));
  try {
    const fixed = Date.UTC(2026, 5, 27, 14, 20, 58, 461);
    const path = await persistAgentArtifact({
      dir,
      slug: "winter-sustainable",
      format: "md",
      content: "# Hello\n",
      now: fixed,
    });
    assert.match(path, /2026-06-27T14-20-58-461Z-winter-sustainable\.md$/);
    assert.equal(await readFile(path, "utf8"), "# Hello\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistAgentArtifact: writes JSON content with .json extension", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persist-json-"));
  try {
    const fixed = Date.UTC(2026, 5, 27, 14, 20, 58, 461);
    const body = `${JSON.stringify({ ok: true }, null, 2)}\n`;
    const path = await persistAgentArtifact({
      dir,
      slug: "winter-sustainable",
      format: "json",
      content: body,
      now: fixed,
    });
    assert.match(path, /2026-06-27T14-20-58-461Z-winter-sustainable\.json$/);
    assert.equal(await readFile(path, "utf8"), body);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistAgentArtifact: rejects unknown format", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persist-bad-"));
  try {
    await assert.rejects(
      persistAgentArtifact({ dir, slug: "x", format: "txt", content: "" }),
      /format must be/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("main: --json writes the same JSON to stdout and to a timestamped artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-persist-json-"));
  const briefDir = await mkdtemp(join(tmpdir(), "cli-brief-"));
  try {
    const briefPath = join(briefDir, "winter-sustainable.txt");
    await writeFile(briefPath, "any brief text");
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await main({
      argv: [briefPath, "--json", "--quiet", `--results-dir=${dir}`],
      stdin: ttyReadable(),
      stdout,
      stderr,
      deps: mockDeps,
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.text);
    assert.equal(parsed.schemaVersion, "1.0");

    const files = await readdir(dir);
    assert.equal(files.length, 1, `expected one artifact, got ${files.join(", ")}`);
    const [name] = files;
    assert.match(name, /-winter-sustainable\.json$/);
    assert.equal(await readFile(join(dir, name), "utf8"), stdout.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(briefDir, { recursive: true, force: true });
  }
});

test("main: default Markdown writes the same Markdown to stdout and to a timestamped .md artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-persist-md-"));
  const briefDir = await mkdtemp(join(tmpdir(), "cli-brief-"));
  try {
    const briefPath = join(briefDir, "winter-sustainable.txt");
    await writeFile(briefPath, "any brief text");
    const stdout = makeWritable();
    const stderr = makeWritable();
    const code = await main({
      argv: [briefPath, "--quiet", `--results-dir=${dir}`],
      stdin: ttyReadable(),
      stdout,
      stderr,
      deps: mockDeps,
    });
    assert.equal(code, 0);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    const [name] = files;
    assert.match(name, /-winter-sustainable\.md$/);
    assert.equal(await readFile(join(dir, name), "utf8"), stdout.text);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(briefDir, { recursive: true, force: true });
  }
});

test("main: pipeline failure does NOT write an artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-persist-fail-"));
  const briefDir = await mkdtemp(join(tmpdir(), "cli-brief-"));
  try {
    const briefPath = join(briefDir, "broken.txt");
    await writeFile(briefPath, "broken brief");
    const failDeps = {
      ...mockDeps,
      compose: async () => { throw new Error("compose blew up"); },
    };
    const stderr = makeWritable();
    const code = await main({
      argv: [briefPath, "--quiet", `--results-dir=${dir}`],
      stdin: ttyReadable(),
      stdout: makeWritable(),
      stderr,
      deps: failDeps,
    });
    assert.equal(code, 1);
    const files = await readdir(dir).catch(() => []);
    assert.equal(files.length, 0, `expected no artifacts on failure, got ${files.join(", ")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(briefDir, { recursive: true, force: true });
  }
});

test("main: stdin brief uses 'stdin' slug for the artifact filename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-persist-stdin-"));
  try {
    const stdout = makeWritable();
    const code = await main({
      argv: ["--json", "--quiet", `--results-dir=${dir}`],
      stdin: stdinFromString("some piped brief\n"),
      stdout,
      stderr: makeWritable(),
      deps: mockDeps,
    });
    assert.equal(code, 0);
    const files = await readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /-stdin\.json$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
