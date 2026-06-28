import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, avgBodyWords } from "../src/seed.js";
import { planFragments } from "../src/generate.js";
import { RESERVED_COUNT, RESERVED_TOPICS } from "../src/topics.js";
import { resolveVariation, TEMPLATE_POOL } from "../src/templates.js";

test("parseArgs applies defaults and parses seed deterministically", () => {
  const a = parseArgs(["--seed=42"]);
  assert.equal(a.seed, 42);
  assert.equal(a.count, 40);
  assert.deepEqual(a.locales, ["en-gb", "fr-fr", "de-de"]);
  assert.equal(a.variation, "medium");
  assert.equal(a.skipEmbeddings, true, "skip-embeddings defaults to true (embed is a separate step)");
  assert.equal(a.concurrency, 4, "default concurrency is 4");
  assert.equal(a.aemPush, undefined, "aemPush removed - use aem-push.js directly if needed");
});

test("parseArgs default --count is 40 per locale (120 total across en-gb,fr-fr,de-de)", () => {
  const a = parseArgs([]);
  assert.equal(a.count, 40, "default --count must be 40 per locale (canonical eval corpus)");
});

test("parseArgs rejects bad count", () => {
  assert.throws(() => parseArgs(["--count=0"]), /--count/);
  assert.throws(() => parseArgs(["--count=201"]), /--count/);
  assert.throws(() => parseArgs(["--count=abc"]), /--count/);
});

test("parseArgs rejects bad variation", () => {
  assert.throws(() => parseArgs(["--variation=extreme"]), /--variation/);
});

test("parseArgs accepts skip-embeddings and dry-run flags", () => {
  const a = parseArgs(["--skip-embeddings", "--dry-run"]);
  assert.equal(a.skipEmbeddings, true);
  assert.equal(a.dryRun, true);
});

test("parseArgs accepts --concurrency override", () => {
  const a = parseArgs(["--concurrency=8"]);
  assert.equal(a.concurrency, 8);
});

test("parseArgs rejects concurrency out of range", () => {
  assert.throws(() => parseArgs(["--concurrency=0"]), /--concurrency/);
  assert.throws(() => parseArgs(["--concurrency=17"]), /--concurrency/);
});

test("parseArgs returns absolute outputPath even on --dry-run (summary contract)", () => {
  const a = parseArgs(["--dry-run", "--output=data/corpus.json"]);
  assert.equal(a.dryRun, true);
  assert.ok(a.outputPath, "outputPath must be set on dry-run for summary inspection");
  assert.ok(a.outputPath.startsWith("/"), `outputPath must be absolute; got ${a.outputPath}`);
  assert.ok(a.outputPath.endsWith("data/corpus.json"));
});

test("avgBodyWords averages whitespace-split tokens", () => {
  assert.equal(avgBodyWords([]), 0);
  assert.equal(
    avgBodyWords([{ content: "one two three" }, { content: "four five" }]),
    3,
  );
});

test("planFragments produces count*locales entries", () => {
  const plan = planFragments({ locales: ["en-gb", "fr-fr"], count: 10, seed: 42 });
  assert.equal(plan.length, 20);
  assert.equal(plan[0].globalIndex, 1);
  assert.equal(plan.at(-1).globalIndex, 20);
});

test("planFragments reserves seasonal-clothing-sustainability topics first per locale", () => {
  const plan = planFragments({ locales: ["en-gb", "fr-fr", "de-de"], count: 40, seed: 7 });
  const reservedTitles = new Set(RESERVED_TOPICS.map((t) => t.title));
  for (const locale of ["en-gb", "fr-fr", "de-de"]) {
    const reservedInLocale = plan
      .filter((p) => p.locale === locale && p.isReserved)
      .filter((p) => reservedTitles.has(p.topic.title));
    assert.equal(
      reservedInLocale.length,
      RESERVED_COUNT,
      `expected ${RESERVED_COUNT} reserved entries for ${locale}`,
    );
  }
});

test("planFragments handles count smaller than reserved pool", () => {
  const plan = planFragments({ locales: ["en-gb"], count: 3, seed: 1 });
  assert.equal(plan.length, 3);
  for (const entry of plan) assert.equal(entry.isReserved, true);
});

test("resolveVariation maps low/medium/high correctly", () => {
  assert.equal(resolveVariation("low").templates.length, 1);
  assert.equal(resolveVariation("medium").templates.length, 3);
  assert.equal(resolveVariation("high").templates.length, TEMPLATE_POOL.length);
  assert.equal(resolveVariation("low").temperature, 0.6);
  assert.equal(resolveVariation("medium").temperature, 1.0);
  assert.equal(resolveVariation("high").temperature, 1.2);
});

test("template pool contains the 6 named templates in order", () => {
  const names = TEMPLATE_POOL.map((t) => t.name);
  assert.deepEqual(names, [
    "premium-narrative",
    "care-instructional",
    "seasonal-aspirational",
    "sustainability-explainer",
    "heritage-voice",
    "inclusive-modern",
  ]);
});
