import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentOutput } from "@aemdisc/shared";
import { render } from "../src/render/markdown.js";

const brief = {
  audience: "Premium UK shoppers interested in sustainability",
  locale: "en-gb",
  tone: "premium",
  brandGuidelines: ["premium-tone", "sustainability-voice"],
  requiredTopics: ["recycled materials", "care instructions", "winter styling"],
  pathHint: "/en-gb/collections/winter-sustainable",
};

const matchedFragments = [
  { id: "frag_001", path: "/content/dam/aemcontentdisc/en-gb/frag_001", score: 0.876543, reason: "Strong semantic match; brand: premium-tone" },
  { id: "frag_002", path: "/content/dam/aemcontentdisc/en-gb/frag_002", score: 0.71, reason: "Direct keyword overlap" },
  { id: "frag_003", path: "/content/dam/aemcontentdisc/en-gb/frag_003", score: 0.6543, reason: "Brand voice match" },
];

const gaps = [
  {
    topic: "winter styling tips for layering",
    coverage: "none",
    description: "Nothing in the corpus covers layering for winter.",
    partialMatches: [],
    suggestedAction: "Write a 200-word en-gb styling guide for layering knitwear.",
  },
  {
    topic: "care instructions",
    coverage: "partial",
    description: "Existing care fragment is shallow and missing brand voice.",
    partialMatches: ["frag_002"],
    suggestedAction: "Expand care fragment with premium-tone language.",
  },
];

const allReuse = {
  schemaVersion: "1.0",
  brief,
  matchedFragments,
  gaps,
  draftOutline: {
    title: "Winter Sustainable Collection",
    pathHint: "/en-gb/collections/winter-sustainable",
    sections: [
      { heading: "Intro", kind: "reuse", fragmentIds: ["frag_001"], rationale: "Sets tone with hero fragment." },
      { heading: "Materials", kind: "reuse", fragmentIds: ["frag_001", "frag_003"], rationale: "Combines material and brand story." },
      { heading: "Care", kind: "reuse", fragmentIds: ["frag_002"], rationale: "Reuses existing care fragment." },
      { heading: "Close", kind: "reuse", fragmentIds: ["frag_003"], rationale: "Closes on brand voice." },
    ],
  },
};

const allNew = {
  ...allReuse,
  draftOutline: {
    title: "Winter Sustainable Collection",
    pathHint: "/en-gb/collections/winter-sustainable",
    sections: [
      { heading: "Intro", kind: "new", rationale: "Need a fresh intro.", sourcingHint: "Write a 100-word hero." },
      { heading: "Materials", kind: "new", rationale: "No recycled-materials story exists.", sourcingHint: "200-word recycled-materials story." },
      { heading: "Care", kind: "new", rationale: "Care fragment missing.", sourcingHint: "Write a 200-word care guide." },
      { heading: "Styling", kind: "new", rationale: "No styling content.", sourcingHint: "Write a layering tips section." },
    ],
  },
};

const mixed = {
  ...allReuse,
  draftOutline: {
    title: "Winter Sustainable Collection",
    pathHint: "/en-gb/collections/winter-sustainable",
    sections: [
      { heading: "Intro", kind: "reuse", fragmentIds: ["frag_001"], rationale: "Hero from existing fragment." },
      { heading: "Materials", kind: "new", rationale: "Need recycled-sourcing story.", sourcingHint: "200-word recycled-sourcing story." },
      { heading: "Care", kind: "reuse", fragmentIds: ["frag_002"], rationale: "Reuse with light edits." },
      { heading: "Styling Tips", kind: "new", rationale: "Layering missing entirely.", sourcingHint: "Write a layering section." },
    ],
  },
};

function assertCommonStructure(md) {
  assert.match(md, /^## Top 3 Matching Content Fragments$/m, "must include matches heading verbatim");
  assert.match(md, /^## Gap Analysis$/m, "must include gaps heading verbatim");
  assert.match(md, /^## Draft Outline$/m, "must include outline heading verbatim");
  assert.match(md, /\| 1 \| <a id="frag_001"><\/a>`frag_001` \| `\/content\/dam\/aemcontentdisc\/en-gb\/frag_001` \| 0\.877 \| /);
  assert.match(md, /\| 2 \|.*0\.710/);
  assert.match(md, /\| 3 \|.*0\.654/);
  assert.match(md, /### Coverage: none[\s\S]*### Coverage: partial/, "none group must precede partial group");
  assert.match(md, /Partial matches: \[`frag_002`\]\(#frag_002\)/);
  assert.match(md, /\*\*Title:\*\* Winter Sustainable Collection/);
  assert.match(md, /\*\*Path hint:\*\* `\/en-gb\/collections\/winter-sustainable`/);
}

test("render: all-reuse outline produces well-formed markdown", () => {
  const out = AgentOutput.parse(allReuse);
  const md = render(out);
  assertCommonStructure(md);
  assert.match(md, /1\. \*\*Intro\*\*\n\s+- Reuse: \[`frag_001`\]\(#frag_001\)/);
  assert.doesNotMatch(md, /\*\*NEW\*\*/, "no NEW markers when all sections reuse");
});

test("render: all-new outline marks each section NEW with sourcing hint", () => {
  const out = AgentOutput.parse(allNew);
  const md = render(out);
  assertCommonStructure(md);
  assert.equal((md.match(/\*\*NEW\*\*/g) ?? []).length, 4, "every section is marked NEW");
  assert.match(md, /Sourcing hint: 200-word recycled-materials story\./);
  assert.doesNotMatch(md, /Reuse: \[/, "no reuse rows when all sections are new");
});

test("render: mixed outline interleaves reuse + new without bleeding fields", () => {
  const out = AgentOutput.parse(mixed);
  const md = render(out);
  assertCommonStructure(md);
  assert.equal((md.match(/\*\*NEW\*\*/g) ?? []).length, 2);
  assert.equal((md.match(/Reuse: \[/g) ?? []).length, 2);
  assert.equal((md.match(/Sourcing hint:/g) ?? []).length, 2);
  assert.match(md, /1\. \*\*Intro\*\*\n\s+- Reuse: \[`frag_001`\]\(#frag_001\)/);
  assert.match(md, /2\. \*\*Materials\*\* \*\*NEW\*\*/);
});

const sampleFragment = (id, title) => ({
  id,
  title,
  category: "product-story",
  targetAudience: "uk-shoppers",
  brandGuidelinesApplied: ["premium-tone", "sustainability-voice"],
  locale: "en-gb",
  lastModified: "2026-01-15T10:00:00.000Z",
  content: `${title} body copy describing the topic in depth.`,
  path: `/content/dam/aemcontentdisc/en-gb/${id}`,
});

test("render: appends Reused Fragments appendix with stable per-id anchor", () => {
  const out = AgentOutput.parse({
    ...mixed,
    reusedFragments: [sampleFragment("frag_001", "Sustainable Merino"), sampleFragment("frag_002", "Winter Care Guide")],
  });
  const md = render(out);
  assert.match(md, /## Reused Fragments/);
  assert.match(md, /### `frag_001` - Sustainable Merino/);
  assert.match(md, /<a id="appendix-frag_001"><\/a>/);
  assert.match(md, /<a id="appendix-frag_002"><\/a>/);
  assert.match(md, /- Path: `\/content\/dam\/aemcontentdisc\/en-gb\/frag_001`/);
  assert.match(md, /- Category: product-story/);
  assert.match(md, /- Locale: en-gb/);
  assert.match(md, /- Brand guidelines: premium-tone, sustainability-voice/);
  assert.match(md, /- Last modified: 2026-01-15T10:00:00\.000Z/);
  assert.match(md, /Sustainable Merino body copy/);
  const draftIdx = md.indexOf("## Draft Outline");
  const appendixIdx = md.indexOf("## Reused Fragments");
  assert.ok(appendixIdx > draftIdx, "appendix must come after Draft Outline");
  assert.match(md, /<a id="frag_001"><\/a>`frag_001`/, "top-match anchor stays intact");
});

test("render: omits Reused Fragments appendix when there are no reuse sections", () => {
  const out = AgentOutput.parse({ ...allNew, reusedFragments: [] });
  const md = render(out);
  assert.doesNotMatch(md, /## Reused Fragments/);
  assert.doesNotMatch(md, /<a id="appendix-/);
});
