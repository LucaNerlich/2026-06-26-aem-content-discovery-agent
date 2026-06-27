import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { compose } from "../src/pipeline/compose.js";

function makeBrief(overrides = {}) {
  return {
    audience: "Premium UK shoppers interested in sustainability",
    locale: "en-gb",
    tone: "premium",
    brandGuidelines: ["premium-tone", "sustainability-voice"],
    requiredTopics: ["winter styling", "sustainable materials", "care guides"],
    pathHint: "/en-gb/collections/winter-sustainable",
    ...overrides,
  };
}

function makeRetrievalResult() {
  const frag = (id, title) => ({
    id,
    title,
    category: "product-story",
    targetAudience: "uk-shoppers",
    brandGuidelinesApplied: ["premium-tone"],
    locale: "en-gb",
    lastModified: "2026-01-15T10:00:00.000Z",
    content: `${title} body copy describing the topic in depth.`,
    path: `/content/dam/aemcontentdisc/en-gb/${id}`,
  });
  return {
    matches: [
      { fragment: frag("frag_001", "Sustainable Merino"), score: 0.87, breakdown: {}, reason: "Strong topic + brand match" },
      { fragment: frag("frag_002", "Winter Care Guide"), score: 0.71, breakdown: {}, reason: "Direct topic match" },
      { fragment: frag("frag_003", "Recycled Materials Story"), score: 0.65, breakdown: {}, reason: "Brand voice match" },
    ],
    nearMisses: [],
    droppedByBrandFilter: [],
    localeRelaxed: false,
    vectorSearchAvailable: true,
  };
}

function makeGaps() {
  return [
    {
      topic: "winter styling tips for layering",
      coverage: "none",
      description: "Nothing in the corpus covers layering for winter.",
      partialMatches: [],
      suggestedAction: "Write a 200-word en-gb styling guide for layering knitwear.",
    },
  ];
}

const reuseSection = (heading, ids) => ({ heading, kind: "reuse", fragmentIds: ids, rationale: "r" });
const newSection = (heading) => ({ heading, kind: "new", rationale: "r", sourcingHint: "s" });

test("compose: all-reuse outline parses", async () => {
  const chat = async () => ({
    title: "Winter Sustainable Collection",
    pathHint: "/wrong/ignored",
    sections: [
      reuseSection("Intro", ["frag_001"]),
      reuseSection("Care", ["frag_002"]),
      reuseSection("Materials", ["frag_003"]),
      reuseSection("Story", ["frag_001", "frag_003"]),
    ],
  });
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  assert.equal(out.schemaVersion, "1.0");
  assert.equal(out.matchedFragments.length, 3);
  assert.ok(out.draftOutline.sections.every((s) => s.kind === "reuse"));
  assert.equal(out.draftOutline.pathHint, "/en-gb/collections/winter-sustainable");
});

test("compose: all-new outline parses", async () => {
  const chat = async () => ({
    title: "Winter Sustainable",
    pathHint: "/x",
    sections: [newSection("A"), newSection("B"), newSection("C"), newSection("D")],
  });
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  assert.ok(out.draftOutline.sections.every((s) => s.kind === "new"));
  assert.equal(out.draftOutline.sections.length, 4);
});

test("compose: mixed outline parses", async () => {
  const chat = async () => ({
    title: "Mixed",
    pathHint: "/x",
    sections: [
      reuseSection("A", ["frag_001"]),
      newSection("B"),
      reuseSection("C", ["frag_002", "frag_003"]),
      newSection("D"),
    ],
  });
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  const reuse = out.draftOutline.sections.filter((s) => s.kind === "reuse");
  const fresh = out.draftOutline.sections.filter((s) => s.kind === "new");
  assert.equal(reuse.length, 2);
  assert.equal(fresh.length, 2);
});

test("compose: malformed section triggers retry, then succeeds", async () => {
  let calls = 0;
  const chat = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        title: "T",
        pathHint: "/x",
        sections: [
          { heading: "A", kind: "reuse", rationale: "r" },
          newSection("B"),
          newSection("C"),
          newSection("D"),
        ],
      };
    }
    return {
      title: "T",
      pathHint: "/x",
      sections: [reuseSection("A", ["frag_001"]), newSection("B"), reuseSection("C", ["frag_002"]), newSection("D")],
    };
  };
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  assert.equal(calls, 2);
  assert.equal(out.draftOutline.sections.length, 4);
});

test("compose: orphan fragmentId triggers retry, then succeeds", async () => {
  let calls = 0;
  const chat = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        title: "T",
        pathHint: "/x",
        sections: [reuseSection("A", ["frag_999"]), newSection("B"), newSection("C"), newSection("D")],
      };
    }
    return {
      title: "T",
      pathHint: "/x",
      sections: [reuseSection("A", ["frag_001"]), newSection("B"), newSection("C"), newSection("D")],
    };
  };
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  assert.equal(calls, 2);
});

test("compose: reusedFragments dedupes and preserves first-use order from outline", async () => {
  const chat = async () => ({
    title: "Mixed",
    pathHint: "/x",
    sections: [
      reuseSection("A", ["frag_002"]),
      newSection("B"),
      reuseSection("C", ["frag_001", "frag_002"]),
      reuseSection("D", ["frag_003", "frag_001"]),
    ],
  });
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  assert.deepEqual(
    out.reusedFragments.map((f) => f.id),
    ["frag_002", "frag_001", "frag_003"],
    "ids appear once each, ordered by first appearance",
  );
  for (const f of out.reusedFragments) {
    assert.ok(f.title);
    assert.ok(f.content);
    assert.ok(f.brandGuidelinesApplied);
    assert.ok(f.lastModified);
    assert.ok(f.category);
    assert.ok(f.locale);
  }
});

test("compose: reusedFragments is empty when outline has no reuse sections", async () => {
  const chat = async () => ({
    title: "All new",
    pathHint: "/x",
    sections: [newSection("A"), newSection("B"), newSection("C"), newSection("D")],
  });
  const out = await compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat });
  assert.deepEqual(out.reusedFragments, []);
});

test("compose: throws ZodError after second consecutive bad shape", async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const chat = async () => ({
      title: "T",
      pathHint: "/x",
      sections: [{ heading: "A", kind: "reuse", rationale: "r" }],
    });
    await assert.rejects(
      () => compose(makeBrief(), makeRetrievalResult(), makeGaps(), { chat }),
      (err) => err instanceof z.ZodError,
    );
  } finally {
    console.error = originalError;
  }
});
