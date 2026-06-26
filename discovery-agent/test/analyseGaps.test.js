import { test } from "node:test";
import assert from "node:assert/strict";

import { analyseGaps } from "../src/pipeline/analyseGaps.js";
import { OllamaJsonParseError } from "@aemdisc/shared";

function frag(overrides = {}) {
  return {
    id: "frag_001",
    title: "Default title",
    category: "product-story",
    targetAudience: "Quality-led shoppers",
    brandGuidelinesApplied: ["premium-tone"],
    locale: "en-gb",
    lastModified: "2026-04-12T09:30:00.000Z",
    content: "Body text about something premium and considered.",
    path: "/content/dam/aemcontentdisc/en-gb/frag_001",
    ...overrides,
  };
}

function match(fragment, score = 0.7) {
  return { fragment, score, breakdown: { cosine: 0.8, bm25: 0.5, freshness: 0.6 }, reason: "" };
}

const briefBase = {
  audience: "Eco-conscious women aged 25-40, UK market",
  locale: "en-gb",
  tone: "premium",
  brandGuidelines: ["sustainability-voice", "premium-tone"],
  requiredTopics: ["recycled materials sourcing", "winter care instructions"],
  pathHint: "/en-gb/collections/winter-sustainable",
};

function fakeChat(verdicts) {
  return async () => verdicts;
}

test("topic with zero candidates is force-classified as none", async () => {
  const retrieval = { matches: [], nearMisses: [], droppedByBrandFilter: [], localeRelaxed: false, vectorSearchAvailable: true };
  const gaps = await analyseGaps(briefBase, retrieval, { chat: fakeChat([]) });
  const topical = gaps.filter((g) => briefBase.requiredTopics.includes(g.topic));
  assert.equal(topical.length, 2);
  for (const g of topical) {
    assert.equal(g.coverage, "none");
    assert.deepEqual(g.partialMatches, []);
    assert.ok(g.suggestedAction.length > 0);
  }
});

test("shallow candidates surface as partial with the right ids", async () => {
  const f1 = frag({ id: "frag_010", title: "Recycled materials note", content: "short" });
  const f2 = frag({ id: "frag_011", title: "Care guide stub", content: "short", brandGuidelinesApplied: ["premium-tone"] });
  const retrieval = {
    matches: [match(f1), match(f2)],
    nearMisses: [],
    droppedByBrandFilter: [],
    localeRelaxed: false,
    vectorSearchAvailable: true,
  };
  const verdicts = [
    { topic: "recycled materials sourcing", coverage: "partial", description: "Touches but shallow.", partialMatches: ["frag_010"], rationale: "Short body." },
    { topic: "winter care instructions", coverage: "partial", description: "Stub only.", partialMatches: ["frag_011"], rationale: "Stub." },
  ];
  const gaps = await analyseGaps(briefBase, retrieval, { chat: fakeChat(verdicts) });
  const byTopic = Object.fromEntries(gaps.map((g) => [g.topic, g]));
  assert.equal(byTopic["recycled materials sourcing"].coverage, "partial");
  assert.deepEqual(byTopic["recycled materials sourcing"].partialMatches, ["frag_010"]);
  assert.equal(byTopic["winter care instructions"].coverage, "partial");
  assert.deepEqual(byTopic["winter care instructions"].partialMatches, ["frag_011"]);
});

test("locale relaxation surfaces as a structural partial gap", async () => {
  const f = frag({ id: "frag_020", locale: "fr-fr", title: "fr content" });
  const retrieval = {
    matches: [match(f)],
    nearMisses: [],
    droppedByBrandFilter: [],
    localeRelaxed: "any",
    vectorSearchAvailable: true,
  };
  const verdicts = briefBase.requiredTopics.map((t) => ({
    topic: t,
    coverage: "none",
    description: "n/a",
    partialMatches: [],
    rationale: "n/a",
  }));
  const gaps = await analyseGaps(briefBase, retrieval, { chat: fakeChat(verdicts) });
  const locale = gaps.find((g) => g.topic.startsWith("Locale-appropriate"));
  assert.ok(locale, "expected locale structural gap");
  assert.equal(locale.coverage, "partial");
  assert.deepEqual(locale.partialMatches, ["frag_020"]);
});

test("brand-guideline gap is partial when droppedByBrandFilter has candidates, none when empty", async () => {
  const matchFrag = frag({ id: "frag_030", brandGuidelinesApplied: ["premium-tone"] });
  const droppedFrag = frag({ id: "frag_031", brandGuidelinesApplied: ["technical-precision"] });
  const retrieval = {
    matches: [match(matchFrag)],
    nearMisses: [],
    droppedByBrandFilter: [match(droppedFrag)],
    localeRelaxed: false,
    vectorSearchAvailable: true,
  };
  const verdicts = briefBase.requiredTopics.map((t) => ({
    topic: t,
    coverage: "none",
    description: "n/a",
    partialMatches: [],
    rationale: "n/a",
  }));
  const gaps = await analyseGaps(briefBase, retrieval, { chat: fakeChat(verdicts) });
  const brandGap = gaps.find((g) => g.topic === "Brand guideline coverage: sustainability-voice");
  assert.ok(brandGap, "expected sustainability-voice brand gap");
  assert.equal(brandGap.coverage, "partial");
  assert.deepEqual(brandGap.partialMatches, ["frag_031"]);
  // premium-tone is in matches; no gap for it
  assert.equal(gaps.find((g) => g.topic === "Brand guideline coverage: premium-tone"), undefined);
});

test("brand-guideline gap is none when droppedByBrandFilter is empty", async () => {
  const matchFrag = frag({ id: "frag_040", brandGuidelinesApplied: ["premium-tone"] });
  const retrieval = {
    matches: [match(matchFrag)],
    nearMisses: [],
    droppedByBrandFilter: [],
    localeRelaxed: false,
    vectorSearchAvailable: true,
  };
  const verdicts = briefBase.requiredTopics.map((t) => ({
    topic: t, coverage: "none", description: "n/a", partialMatches: [], rationale: "n/a",
  }));
  const gaps = await analyseGaps(briefBase, retrieval, { chat: fakeChat(verdicts) });
  const brandGap = gaps.find((g) => g.topic === "Brand guideline coverage: sustainability-voice");
  assert.ok(brandGap);
  assert.equal(brandGap.coverage, "none");
  assert.deepEqual(brandGap.partialMatches, []);
});

test("partialMatches with invalid ids are filtered and coverage downgraded to none", async () => {
  const f = frag({ id: "frag_050" });
  const retrieval = { matches: [match(f)], nearMisses: [], droppedByBrandFilter: [], localeRelaxed: false, vectorSearchAvailable: true };
  const verdicts = [
    { topic: "recycled materials sourcing", coverage: "partial", description: "x", partialMatches: ["frag_DOES_NOT_EXIST"], rationale: "x" },
    { topic: "winter care instructions", coverage: "partial", description: "x", partialMatches: ["frag_050", "frag_BOGUS"], rationale: "x" },
  ];
  const gaps = await analyseGaps(briefBase, retrieval, { chat: fakeChat(verdicts) });
  const byTopic = Object.fromEntries(gaps.filter((g) => briefBase.requiredTopics.includes(g.topic)).map((g) => [g.topic, g]));
  assert.equal(byTopic["recycled materials sourcing"].coverage, "none");
  assert.deepEqual(byTopic["recycled materials sourcing"].partialMatches, []);
  assert.equal(byTopic["winter care instructions"].coverage, "partial");
  assert.deepEqual(byTopic["winter care instructions"].partialMatches, ["frag_050"]);
});

test("retries once on OllamaJsonParseError and succeeds", async () => {
  const f = frag({ id: "frag_060" });
  const retrieval = { matches: [match(f)], nearMisses: [], droppedByBrandFilter: [], localeRelaxed: false, vectorSearchAvailable: true };
  let calls = 0;
  const chat = async () => {
    calls += 1;
    if (calls === 1) throw new OllamaJsonParseError("bad json");
    return briefBase.requiredTopics.map((t) => ({
      topic: t, coverage: "none", description: "x", partialMatches: [], rationale: "x",
    }));
  };
  const gaps = await analyseGaps(briefBase, retrieval, { chat });
  assert.equal(calls, 2);
  assert.ok(gaps.length >= briefBase.requiredTopics.length);
});

test("retries once on ZodError (malformed verdict) and succeeds", async () => {
  const f = frag({ id: "frag_070" });
  const retrieval = { matches: [match(f)], nearMisses: [], droppedByBrandFilter: [], localeRelaxed: false, vectorSearchAvailable: true };
  let calls = 0;
  const chat = async () => {
    calls += 1;
    if (calls === 1) return [{ topic: "x", coverage: "weird", description: "x", partialMatches: [], rationale: "x" }];
    return briefBase.requiredTopics.map((t) => ({
      topic: t, coverage: "none", description: "x", partialMatches: [], rationale: "x",
    }));
  };
  const gaps = await analyseGaps(briefBase, retrieval, { chat });
  assert.equal(calls, 2);
  assert.ok(gaps.length >= briefBase.requiredTopics.length);
});

test("propagates non-retryable errors immediately", async () => {
  const f = frag({ id: "frag_080" });
  const retrieval = { matches: [match(f)], nearMisses: [], droppedByBrandFilter: [], localeRelaxed: false, vectorSearchAvailable: true };
  const chat = async () => { throw new TypeError("nope"); };
  await assert.rejects(analyseGaps(briefBase, retrieval, { chat }), TypeError);
});

// Regression: Ollama `format: "json"` mode forces a top-level JSON object, so
// the gap-analyser asks the model for `{ "verdicts": [...] }`. Verify that
// shape parses correctly and yields the right Gap[].
test("accepts wrapped {verdicts: [...]} response (Ollama JSON mode)", async () => {
  const f = frag({ id: "frag_090", title: "Recycled winter coats" });
  const retrieval = {
    matches: [match(f)],
    nearMisses: [],
    droppedByBrandFilter: [],
    localeRelaxed: false,
    vectorSearchAvailable: true,
  };
  const wrapped = {
    verdicts: [
      { topic: "recycled materials sourcing", coverage: "partial", description: "Touches the topic.", partialMatches: ["frag_090"], rationale: "Title hits it." },
      { topic: "winter care instructions", coverage: "none", description: "Not addressed.", partialMatches: [], rationale: "No fragment covers care." },
    ],
  };
  const chat = async () => wrapped;
  const gaps = await analyseGaps(briefBase, retrieval, { chat });
  const byTopic = Object.fromEntries(
    gaps.filter((g) => briefBase.requiredTopics.includes(g.topic)).map((g) => [g.topic, g]),
  );
  assert.equal(byTopic["recycled materials sourcing"].coverage, "partial");
  assert.deepEqual(byTopic["recycled materials sourcing"].partialMatches, ["frag_090"]);
  assert.equal(byTopic["winter care instructions"].coverage, "none");
  assert.deepEqual(byTopic["winter care instructions"].partialMatches, []);
});
