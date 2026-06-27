import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runBriefWithRetry,
  buildIndexReadme,
  instrumentStages,
  localeFromSlug,
  buildSeedSummary,
  inferLocale,
  corpusPrecheck,
} from "../full-run.js";

const brief = {
  audience: "UK shoppers",
  locale: "en-gb",
  tone: "premium",
  brandGuidelines: ["premium-tone"],
  requiredTopics: ["a", "b"],
  pathHint: "/en-gb/x",
};

const retrieval = {
  matches: [
    { fragment: { id: "frag_001", path: "/p/1", title: "T1", content: "..." }, score: 0.8, breakdown: {}, reason: "match" },
  ],
  nearMisses: [],
  droppedByBrandFilter: [],
  localeRelaxed: false,
  vectorSearchAvailable: true,
};

const validOutput = {
  schemaVersion: "1.0",
  brief,
  matchedFragments: [{ id: "frag_001", path: "/p/1", score: 0.8, reason: "match" }],
  gaps: [
    { topic: "a", coverage: "none", description: "missing", partialMatches: [], suggestedAction: "write it" },
    { topic: "b", coverage: "partial", description: "thin", partialMatches: ["frag_001"], suggestedAction: "extend" },
  ],
  draftOutline: {
    title: "T",
    pathHint: "/en-gb/x",
    sections: [
      { heading: "Intro", kind: "reuse", fragmentIds: ["frag_001"], rationale: "r" },
    ],
  },
};

const stages = {
  parseBrief: async () => brief,
  retrieve: async () => retrieval,
  analyseGaps: async () => validOutput.gaps,
  compose: async () => validOutput,
};

const okPipeline = async (_text, _opts, deps) => {
  const b = await deps.parseBrief(_text);
  await deps.retrieve(b, {});
  await deps.analyseGaps(b, {});
  return deps.compose(b, {}, []);
};

const renderStub = (out) => `MD for ${out.brief.locale}`;

async function newTmp() {
  return mkdtemp(join(tmpdir(), "full-run-test-"));
}

test("localeFromSlug: extracts known locale prefixes", () => {
  assert.equal(localeFromSlug("en-gb-spring-rewear"), "en-gb");
  assert.equal(localeFromSlug("fr-fr-loungewear-premium"), "fr-fr");
  assert.equal(localeFromSlug("de-de-workwear-tech"), "de-de");
  assert.equal(localeFromSlug("en-us-holiday-gifting"), "en-us");
  assert.equal(localeFromSlug("winter-sustainable"), "n/a");
});

test("instrumentStages: records duration per stage", async () => {
  let tick = 0;
  const now = () => (tick += 10);
  const { deps, stageDurations } = instrumentStages(stages, now);
  await deps.parseBrief("x");
  await deps.retrieve({}, {});
  await deps.analyseGaps({}, {});
  await deps.compose({}, {}, []);
  assert.ok(stageDurations.parseBrief >= 0);
  assert.ok(stageDurations.retrieve >= 0);
  assert.ok(stageDurations.analyseGaps >= 0);
  assert.ok(stageDurations.compose >= 0);
});

test("runBriefWithRetry: ok path writes .json, .md, and .meta.json with correct shape", async () => {
  const dir = await newTmp();
  try {
    const meta = await runBriefWithRetry(
      { slug: "fixture-ok", text: "hello brief text" },
      {
        source: { kind: "stub" },
        runPipeline: okPipeline,
        stages,
        render: renderStub,
        runsDir: dir,
        chatModel: "gemma4:26b",
        embeddingModel: "embeddinggemma:300m",
        now: () => Date.now(),
      },
    );
    assert.equal(meta.status, "ok");
    assert.equal(meta.retryCount, 0);
    assert.equal(meta.matchedFragmentCount, 1);
    assert.deepEqual(meta.gapCounts, { none: 1, partial: 1 });

    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ["fixture-ok.json", "fixture-ok.md", "fixture-ok.meta.json"]);

    const written = JSON.parse(await readFile(join(dir, "fixture-ok.json"), "utf8"));
    assert.equal(written.schemaVersion, "1.0");
    const md = await readFile(join(dir, "fixture-ok.md"), "utf8");
    assert.match(md, /MD for en-gb/);
    const writtenMeta = JSON.parse(await readFile(join(dir, "fixture-ok.meta.json"), "utf8"));
    assert.equal(writtenMeta.slug, "fixture-ok");
    assert.equal(writtenMeta.chatModel, "gemma4:26b");
    assert.equal(writtenMeta.embeddingModel, "embeddinggemma:300m");
    assert.ok(typeof writtenMeta.stageDurations.parseBrief === "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBriefWithRetry: error path writes ONLY .meta.json with status=error", async () => {
  const dir = await newTmp();
  try {
    const throwPipeline = async () => { throw new Error("boom"); };
    const meta = await runBriefWithRetry(
      { slug: "fixture-err", text: "broken brief" },
      {
        source: { kind: "stub" },
        runPipeline: throwPipeline,
        stages,
        render: renderStub,
        runsDir: dir,
        chatModel: "gemma4:26b",
        embeddingModel: "embeddinggemma:300m",
        now: () => Date.now(),
      },
    );
    assert.equal(meta.status, "error");
    assert.equal(meta.retryCount, 1);
    assert.match(meta.error, /boom/);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ["fixture-err.meta.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBriefWithRetry: timeout path is classified as status=timeout", async () => {
  const dir = await newTmp();
  try {
    const timeoutPipeline = async () => { throw new Error("Ollama request timed out after 120000ms"); };
    const meta = await runBriefWithRetry(
      { slug: "fixture-timeout", text: "slow brief" },
      {
        source: { kind: "stub" },
        runPipeline: timeoutPipeline,
        stages,
        render: renderStub,
        runsDir: dir,
        chatModel: "gemma4:26b",
        embeddingModel: "embeddinggemma:300m",
        now: () => Date.now(),
      },
    );
    assert.equal(meta.status, "timeout");
    assert.equal(meta.retryCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBriefWithRetry: LlmTimeoutError class-name string is classified as status=timeout", async () => {
  const dir = await newTmp();
  try {
    const timeoutPipeline = async () => { throw new Error("LlmTimeoutError: aborted after 120000ms"); };
    const meta = await runBriefWithRetry(
      { slug: "fixture-llm-timeout", text: "slow brief" },
      {
        source: { kind: "stub" },
        runPipeline: timeoutPipeline,
        stages,
        render: renderStub,
        runsDir: dir,
        chatModel: "gemma4:26b",
        embeddingModel: "embeddinggemma:300m",
        now: () => Date.now(),
      },
    );
    assert.equal(meta.status, "timeout");
    assert.equal(meta.retryCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBriefWithRetry: second-attempt success records retryCount=1", async () => {
  const dir = await newTmp();
  try {
    let calls = 0;
    const flakyPipeline = async (_text, _opts, deps) => {
      calls += 1;
      if (calls === 1) throw new Error("first try fails");
      return okPipeline(_text, _opts, deps);
    };
    const meta = await runBriefWithRetry(
      { slug: "fixture-flaky", text: "flaky brief" },
      {
        source: { kind: "stub" },
        runPipeline: flakyPipeline,
        stages,
        render: renderStub,
        runsDir: dir,
        chatModel: "gemma4:26b",
        embeddingModel: "embeddinggemma:300m",
        now: () => Date.now(),
      },
    );
    assert.equal(meta.status, "ok");
    assert.equal(meta.retryCount, 1);
    assert.equal(calls, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildIndexReadme: emits header counts and one row per meta", () => {
  const md = buildIndexReadme(
    [
      { slug: "a", locale: "en-gb", status: "ok", durationMs: 100, matchedFragmentCount: 3, gapCounts: { none: 1, partial: 2 } },
      { slug: "b", locale: "fr-fr", status: "timeout", durationMs: 240000 },
      { slug: "c", locale: "de-de", status: "error", durationMs: 50, error: "schema" },
    ],
    {
      chatModel: "gemma4:26b",
      embeddingModel: "embeddinggemma:300m",
      seed: 20260626,
      generatedAt: "2026-06-26T00:00:00Z",
      totalDurationMs: 240150,
    },
  );
  assert.match(md, /generatedAt: `2026-06-26T00:00:00Z`/);
  assert.match(md, /chatModel: `gemma4:26b`/);
  assert.match(md, /\*\*1\*\* \/ \*\*1\*\* \/ \*\*1\*\*/);
  assert.match(md, /\| `a` \| en-gb \| 3 \| 1 \/ 2 \| ok \| 100 \| \[md\]\(\.\/a\.md\) \|/);
  assert.match(md, /\| `b` \| fr-fr \|  \|  \| timeout \| 240000 \| — \|/);
  assert.match(md, /\| `c` \| de-de \|  \|  \| error \| 50 \| — \|/);
});

test("buildSeedSummary: missing corpus returns not-seeded note", async () => {
  const dir = await newTmp();
  try {
    const summary = await buildSeedSummary(join(dir, "missing.json"));
    assert.equal(summary.status, "not-seeded");
    assert.match(summary.note, /npm run seed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inferLocale: falls back to expectations localeOverride when slug has no prefix", async () => {
  const dir = await newTmp();
  try {
    await writeFile(
      join(dir, "winter-sustainable.json"),
      JSON.stringify({ localeOverride: "en-gb" }),
    );
    const locale = await inferLocale("winter-sustainable", "no locale token here", dir);
    assert.equal(locale, "en-gb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inferLocale: falls back to text scan when no prefix and no override", async () => {
  const dir = await newTmp();
  try {
    const locale = await inferLocale(
      "winter-sustainable",
      "The page will sit under /en-gb/collections/winter-sustainable",
      dir,
    );
    assert.equal(locale, "en-gb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inferLocale: returns n/a when nothing matches", async () => {
  const dir = await newTmp();
  try {
    const locale = await inferLocale("no-prefix", "plain text with no locale token", dir);
    assert.equal(locale, "n/a");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("inferLocale: prefers slug prefix over text scan", async () => {
  const locale = await inferLocale("fr-fr-loungewear", "mentions /en-gb/somewhere", "/nope");
  assert.equal(locale, "fr-fr");
});

test("corpusPrecheck: fails when corpus is missing", async () => {
  const dir = await newTmp();
  try {
    const res = await corpusPrecheck(join(dir, "missing.json"));
    assert.equal(res.ok, false);
    assert.match(res.reason, /missing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corpusPrecheck: fails when locales are incomplete", async () => {
  const dir = await newTmp();
  try {
    const path = join(dir, "corpus.json");
    const fragments = [];
    for (let i = 0; i < 24; i += 1) fragments.push({ id: `f${i}`, locale: "en-gb" });
    await writeFile(path, JSON.stringify({ fragments }));
    const res = await corpusPrecheck(path);
    assert.equal(res.ok, false);
    assert.match(res.reason, /missing locales/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corpusPrecheck: ok when 24+ fragments cover required locales", async () => {
  const dir = await newTmp();
  try {
    const path = join(dir, "corpus.json");
    const fragments = [];
    for (let i = 0; i < 8; i += 1) fragments.push({ id: `e${i}`, locale: "en-gb" });
    for (let i = 0; i < 8; i += 1) fragments.push({ id: `f${i}`, locale: "fr-fr" });
    for (let i = 0; i < 8; i += 1) fragments.push({ id: `d${i}`, locale: "de-de" });
    await writeFile(path, JSON.stringify({ fragments }));
    const res = await corpusPrecheck(path);
    assert.equal(res.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runBriefWithRetry: error meta carries partial stageDurations from instrumented run", async () => {
  const dir = await newTmp();
  try {
    const partialPipeline = async (_text, _opts, deps) => {
      const b = await deps.parseBrief(_text);
      await deps.retrieve(b, {});
      throw new Error("boom after retrieve");
    };
    const meta = await runBriefWithRetry(
      { slug: "fixture-partial", text: "brief" },
      {
        source: { kind: "stub" },
        runPipeline: partialPipeline,
        stages,
        render: renderStub,
        runsDir: dir,
        chatModel: "qwen3.5:9b",
        embeddingModel: "embeddinggemma:300m",
        now: () => Date.now(),
      },
    );
    assert.equal(meta.status, "error");
    assert.ok(typeof meta.stageDurations.parseBrief === "number");
    assert.ok(typeof meta.stageDurations.retrieve === "number");
    assert.equal(meta.stageDurations.analyseGaps, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildSeedSummary: counts fragments and locales when corpus exists", async () => {
  const dir = await newTmp();
  try {
    const corpusPath = join(dir, "corpus.json");
    await mkdir(dir, { recursive: true });
    await writeFile(
      corpusPath,
      JSON.stringify({
        schemaVersion: "1.0",
        generatedAt: "2026-06-26T12:00:00Z",
        model: "gemma4:26b",
        embeddingModel: "embeddinggemma:300m",
        fragments: [
          { id: "f1", locale: "en-gb" },
          { id: "f2", locale: "en-gb" },
          { id: "f3", locale: "fr-fr" },
        ],
      }),
    );
    const summary = await buildSeedSummary(corpusPath);
    assert.equal(summary.fragmentCount, 3);
    assert.deepEqual(summary.locales, { "en-gb": 2, "fr-fr": 1 });
    assert.equal(summary.generatedAt, "2026-06-26T12:00:00Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
