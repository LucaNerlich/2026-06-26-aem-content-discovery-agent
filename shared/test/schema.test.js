import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Fragment,
  Corpus,
  StructuredBrief,
  AgentOutput,
  MatchedFragment,
  Gap,
  SectionUnion,
} from "../src/index.js";

const validFragment = {
  id: "frag_001",
  title: "Recycled Wool Story",
  category: "product-story",
  targetAudience: "Eco-conscious women aged 25-40, UK market.",
  brandGuidelinesApplied: ["sustainability-voice", "premium-tone"],
  locale: "en-gb",
  lastModified: "2026-04-12T09:30:00Z",
  content: "Body text long enough to be useful.",
};

const validBrief = {
  audience: "Eco-conscious women aged 25-40, UK market.",
  locale: "en-gb",
  tone: "premium",
  brandGuidelines: ["sustainability-voice", "premium-tone"],
  requiredTopics: ["recycled materials", "care instructions", "winter styling"],
  pathHint: "/en-gb/collections/winter-sustainable",
};

const validMatched = {
  id: "frag_001",
  path: "/content/dam/aemcontentdisc/en-gb/frag_001",
  score: 0.82,
  reason: "Covers recycled-wool sourcing in premium tone for en-gb.",
};

const validGap = {
  topic: "winter styling",
  coverage: "none",
  description: "No fragment covers seasonal styling tips for winter.",
  partialMatches: [],
  suggestedAction: "Write a 200-word en-gb winter styling guide.",
};

const validReuseSection = {
  heading: "Our recycled materials story",
  kind: "reuse",
  fragmentIds: ["frag_001"],
  rationale: "Existing fragment matches sourcing requirements.",
};

const validNewSection = {
  heading: "Winter styling tips",
  kind: "new",
  rationale: "No fragment covers this in en-gb.",
  sourcingHint: "Write a 200-word en-gb winter styling guide.",
};

const validOutput = {
  schemaVersion: "1.0",
  brief: validBrief,
  matchedFragments: [validMatched],
  gaps: [validGap],
  draftOutline: {
    title: "Winter Sustainable Collection",
    pathHint: "/en-gb/collections/winter-sustainable",
    sections: [validReuseSection, validNewSection],
  },
};

test("Fragment: happy path parses", () => {
  assert.doesNotThrow(() => Fragment.parse(validFragment));
});

test("Fragment: optional path accepted when present and absent", () => {
  assert.doesNotThrow(() => Fragment.parse({ ...validFragment, path: "/x" }));
  const parsed = Fragment.parse(validFragment);
  assert.equal(parsed.path, undefined);
});

test("Fragment: missing locale fails with descriptive error", () => {
  const { locale, ...rest } = validFragment;
  const result = Fragment.safeParse(rest);
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "locale"));
});

test("Fragment: invalid category enum fails with field name", () => {
  const result = Fragment.safeParse({ ...validFragment, category: "not-a-category" });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "category"));
});

test("Corpus: rejects fragment with missing locale", () => {
  const { locale, ...bad } = validFragment;
  const result = Corpus.safeParse({
    schemaVersion: "1.0",
    generatedAt: "2026-06-26T12:00:00Z",
    model: "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment",
    embeddingModel: "embeddinggemma:300m",
    fragments: [bad],
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".").endsWith("locale")));
});

test("Corpus: happy path parses", () => {
  assert.doesNotThrow(() =>
    Corpus.parse({
      schemaVersion: "1.0",
      generatedAt: "2026-06-26T12:00:00Z",
      model: "/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment",
      embeddingModel: "embeddinggemma:300m",
      fragments: [validFragment],
    }),
  );
});

test("Corpus: persists optional provenance (seed, perLocaleCount, locales)", () => {
  const parsed = Corpus.parse({
    schemaVersion: "1.0",
    generatedAt: "2026-06-26T12:00:00Z",
    model: "m",
    embeddingModel: "e",
    seed: 20260626,
    perLocaleCount: 40,
    locales: ["en-gb", "fr-fr", "de-de"],
    fragments: [validFragment],
  });
  assert.equal(parsed.seed, 20260626);
  assert.equal(parsed.perLocaleCount, 40);
  assert.deepEqual(parsed.locales, ["en-gb", "fr-fr", "de-de"]);
});

test("Corpus: provenance fields are optional (older corpus files still parse)", () => {
  const parsed = Corpus.parse({
    schemaVersion: "1.0",
    generatedAt: "2026-06-26T12:00:00Z",
    model: "m",
    embeddingModel: "e",
    fragments: [validFragment],
  });
  assert.equal(parsed.seed, undefined);
});

test("StructuredBrief: happy path parses", () => {
  assert.doesNotThrow(() => StructuredBrief.parse(validBrief));
});

test("StructuredBrief: missing audience fails with field name", () => {
  const { audience, ...rest } = validBrief;
  const result = StructuredBrief.safeParse(rest);
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "audience"));
});

test("StructuredBrief: rejects empty requiredTopics array", () => {
  const result = StructuredBrief.safeParse({ ...validBrief, requiredTopics: [] });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "requiredTopics"));
});

test("StructuredBrief: rejects requiredTopics containing empty string", () => {
  const result = StructuredBrief.safeParse({
    ...validBrief,
    requiredTopics: ["recycled materials", ""],
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".").startsWith("requiredTopics")));
});

test("MatchedFragment: rejects reason of 141 chars", () => {
  const result = MatchedFragment.safeParse({ ...validMatched, reason: "x".repeat(141) });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "reason"));
});

test("MatchedFragment: rejects score of 1.01", () => {
  const result = MatchedFragment.safeParse({ ...validMatched, score: 1.01 });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "score"));
});

test("MatchedFragment: rejects score below 0", () => {
  const result = MatchedFragment.safeParse({ ...validMatched, score: -0.01 });
  assert.equal(result.success, false);
});

test("Gap: rejects invalid coverage value", () => {
  const result = Gap.safeParse({ ...validGap, coverage: "full" });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "coverage"));
});

test("SectionUnion: rejects reuse section with empty fragmentIds", () => {
  const result = SectionUnion.safeParse({ ...validReuseSection, fragmentIds: [] });
  assert.equal(result.success, false);
});

test("SectionUnion: rejects new section that carries fragmentIds", () => {
  const result = SectionUnion.safeParse({
    ...validNewSection,
    fragmentIds: ["frag_001"],
  });
  assert.equal(result.success, false);
});

test("SectionUnion: discriminates on kind", () => {
  assert.doesNotThrow(() => SectionUnion.parse(validReuseSection));
  assert.doesNotThrow(() => SectionUnion.parse(validNewSection));
  const result = SectionUnion.safeParse({ ...validReuseSection, kind: "mixed" });
  assert.equal(result.success, false);
});

test("AgentOutput: happy path parses", () => {
  assert.doesNotThrow(() => AgentOutput.parse(validOutput));
});

test("AgentOutput: rejects more than 3 matched fragments", () => {
  const four = [validMatched, validMatched, validMatched, validMatched];
  const result = AgentOutput.safeParse({ ...validOutput, matchedFragments: four });
  assert.equal(result.success, false);
});

test("AgentOutput: rejects wrong schemaVersion", () => {
  const result = AgentOutput.safeParse({ ...validOutput, schemaVersion: "2.0" });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "schemaVersion"));
});

test("AgentOutput: rejects draftOutline with more than 8 sections", () => {
  const nine = Array.from({ length: 9 }, () => validNewSection);
  const result = AgentOutput.safeParse({
    ...validOutput,
    draftOutline: { ...validOutput.draftOutline, sections: nine },
  });
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some((i) => i.path.join(".") === "draftOutline.sections"),
    `expected an issue on draftOutline.sections; got ${JSON.stringify(result.error.issues)}`,
  );
});

test("AgentOutput: rejects draftOutline with zero sections", () => {
  const result = AgentOutput.safeParse({
    ...validOutput,
    draftOutline: { ...validOutput.draftOutline, sections: [] },
  });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((i) => i.path.join(".") === "draftOutline.sections"));
});

test("AgentOutput: reusedFragments defaults to empty array when omitted", () => {
  const parsed = AgentOutput.parse(validOutput);
  assert.deepEqual(parsed.reusedFragments, []);
});

test("AgentOutput: reusedFragments accepts full Fragment objects", () => {
  const parsed = AgentOutput.parse({ ...validOutput, reusedFragments: [validFragment] });
  assert.equal(parsed.reusedFragments.length, 1);
  assert.equal(parsed.reusedFragments[0].id, "frag_001");
  assert.equal(parsed.reusedFragments[0].title, "Recycled Wool Story");
});

test("AgentOutput: reusedFragments rejects malformed fragment entry", () => {
  const bad = { ...validFragment, locale: "xx-zz" };
  const result = AgentOutput.safeParse({ ...validOutput, reusedFragments: [bad] });
  assert.equal(result.success, false);
  assert.ok(
    result.error.issues.some((i) => i.path.join(".").startsWith("reusedFragments.0.locale")),
    `expected an issue on reusedFragments.0.locale; got ${JSON.stringify(result.error.issues)}`,
  );
});
