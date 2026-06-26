# Sample Run

A real end-to-end invocation of the agent against `eval/briefs/winter-sustainable.txt`.

## Input brief (verbatim)

`eval/briefs/winter-sustainable.txt`:

```
I'm writing a landing page for our new sustainable winter collection. Target
audience is eco-conscious women aged 25–40 in the UK market. The page needs to
cover: our recycled materials sourcing story, care instructions that extend
garment life, and seasonal styling tips. Tone should match our premium brand
voice. The page will sit under `/en-gb/collections/winter-sustainable`.
```

## Reproduction

```bash
npm run agent eval/briefs/winter-sustainable.txt
# JSON shape (canonical AgentOutput):
npm run agent eval/briefs/winter-sustainable.txt -- --json
```

Both invocations exercise the full pipeline: `parseBrief → retrieve →
analyseGaps → compose`. The corpus is `data/corpus.json` (seed `20260626`,
72 fragments across `en-gb`, `fr-fr`, `de-de`).

> **Note.** Body text (gap descriptions, outline rationale) is LLM-generated
> and therefore drifts run-to-run. The schema, the `matchedFragments` block,
> and the structural locale / brand gaps are deterministic.
>
> The transcript below was captured with chat model `qwen2.5-coder:1.5b`
> (the locked default is `gemma4:26b` — swap it via `config/models.json` if
> your hardware can handle the 120 s timeout). The JSON block was captured in
> a single invocation; the Markdown block is the canonical render of that same
> JSON via `discovery-agent/src/render/markdown.js`.

## Output — `--json` (canonical `AgentOutput`)

```json
{
  "schemaVersion": "1.0",
  "brief": {
    "audience": "Eco-conscious women aged 25–40 in the UK market",
    "locale": "en-gb",
    "tone": "premium",
    "brandGuidelines": [
      "sustainability-voice",
      "technical-precision"
    ],
    "requiredTopics": [
      "recycled materials sourcing story",
      "care instructions that extend garment life",
      "seasonal styling tips"
    ],
    "pathHint": "/en-gb/collections/winter-sustainable"
  },
  "matchedFragments": [
    {
      "id": "frag_008",
      "path": "/content/dam/aemcontentdisc/en-gb/frag_008",
      "score": 0.6222149228678986,
      "reason": "Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content"
    },
    {
      "id": "frag_004",
      "path": "/content/dam/aemcontentdisc/en-gb/frag_004",
      "score": 0.5767126890716463,
      "reason": "Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content"
    },
    {
      "id": "frag_012",
      "path": "/content/dam/aemcontentdisc/en-gb/frag_012",
      "score": 0.5283427664387867,
      "reason": "Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content"
    }
  ],
  "gaps": [
    {
      "topic": "recycled materials sourcing story",
      "coverage": "partial",
      "description": "The candidate fragment with ID 'frag_010' addresses the need for recycled materials in resort wear but does not cover the specific part about sourcing stories.",
      "partialMatches": ["frag_010"],
      "suggestedAction": "Write a 200-word en-gb product-story fragment covering \"recycled materials sourcing story\", applying sustainability-voice and technical-precision."
    },
    {
      "topic": "care instructions that extend garment life",
      "coverage": "partial",
      "description": "The candidate fragments with IDs 'frag_001' and 'frag_011' provide care instruction guides, which covers the need to extend garment life but does not cover seasonal styling tips.",
      "partialMatches": ["frag_001", "frag_011"],
      "suggestedAction": "Write a 200-word en-gb care-guide fragment covering \"care instructions that extend garment life\", applying sustainability-voice and technical-precision."
    },
    {
      "topic": "seasonal styling tips",
      "coverage": "none",
      "description": "There are no candidate fragments in the pool that address the need for seasonal styling tips.",
      "partialMatches": [],
      "suggestedAction": "Write a 200-word en-gb seasonal-campaign fragment covering \"seasonal styling tips\", applying sustainability-voice and technical-precision."
    },
    {
      "topic": "Brand guideline coverage: technical-precision",
      "coverage": "partial",
      "description": "No top match applies the `technical-precision` brand guideline required by the brief. Some candidates exist but lacked any required brand guideline and were filtered out.",
      "partialMatches": ["frag_003", "frag_005", "frag_001", "frag_011", "frag_010"],
      "suggestedAction": "Add fragments tagged `technical-precision` (alongside sustainability-voice) for the en-gb corpus so this brand voice is represented in the top matches."
    }
  ],
  "draftOutline": {
    "title": "Product Brief: Eco-conscious Women's Winter Sustainable Collection",
    "pathHint": "/en-gb/collections/winter-sustainable",
    "sections": [
      {
        "heading": "Introduction",
        "kind": "new",
        "rationale": "This section will briefly introduce the eco-conscious collection, highlighting its unique selling points and potential market appeal.",
        "sourcingHint": "Create a 150-word en-gb intro fragment that encompasses the brand's values, unique features, and target audience."
      },
      {
        "heading": "Collection Highlights",
        "kind": "new",
        "rationale": "This section will provide a detailed overview of the key products in the collection, including their care instructions, sourcing stories, and seasonal styling tips.",
        "sourcingHint": "Write a 300-word en-gb body fragment that includes comprehensive details on each product, focusing on their innovative care solutions and sustainability aspects."
      },
      {
        "heading": "Care Instructions That Extend Garment Life",
        "kind": "new",
        "rationale": "This section will provide detailed care instructions for each product in the collection, highlighting their unique care needs and extended life benefits.",
        "sourcingHint": "Write a 200-word en-gb care-guide fragment that covers the care instructions for all products, focusing on extended garment life and sustainability elements."
      },
      {
        "heading": "Sourcing Story: Recycled Materials in Resort Wear",
        "kind": "new",
        "rationale": "This section will provide a comprehensive sourcing story for recycled materials in resort wear, highlighting the challenges faced and innovative solutions employed.",
        "sourcingHint": "Write a 300-word en-gb source-story fragment that details the sourcing process for recycled materials, including ethical considerations and innovative solutions."
      }
    ]
  }
}
```

## Output — Markdown (default)

```markdown
## Top 3 Matching Content Fragments

| # | id | path | score | reason |
|---|----|------|-------|--------|
| 1 | <a id="frag_008"></a>`frag_008` | `/content/dam/aemcontentdisc/en-gb/frag_008` | 0.622 | Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content |
| 2 | <a id="frag_004"></a>`frag_004` | `/content/dam/aemcontentdisc/en-gb/frag_004` | 0.577 | Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content |
| 3 | <a id="frag_012"></a>`frag_012` | `/content/dam/aemcontentdisc/en-gb/frag_012` | 0.528 | Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content |

## Gap Analysis

### Coverage: none

#### seasonal styling tips
There are no candidate fragments in the pool that address the need for seasonal styling tips.
- Suggested action: Write a 200-word en-gb seasonal-campaign fragment covering "seasonal styling tips", applying sustainability-voice and technical-precision.

### Coverage: partial

#### recycled materials sourcing story
The candidate fragment with ID 'frag_010' addresses the need for recycled materials in resort wear but does not cover the specific part about sourcing stories.
- Partial matches: [`frag_010`](#frag_010)
- Suggested action: Write a 200-word en-gb product-story fragment covering "recycled materials sourcing story", applying sustainability-voice and technical-precision.

#### care instructions that extend garment life
The candidate fragments with IDs 'frag_001' and 'frag_011' provide care instruction guides, which covers the need to extend garment life but does not cover seasonal styling tips.
- Partial matches: [`frag_001`](#frag_001), [`frag_011`](#frag_011)
- Suggested action: Write a 200-word en-gb care-guide fragment covering "care instructions that extend garment life", applying sustainability-voice and technical-precision.

#### Brand guideline coverage: technical-precision
No top match applies the `technical-precision` brand guideline required by the brief. Some candidates exist but lacked any required brand guideline and were filtered out.
- Partial matches: [`frag_003`](#frag_003), [`frag_005`](#frag_005), [`frag_001`](#frag_001), [`frag_011`](#frag_011), [`frag_010`](#frag_010)
- Suggested action: Add fragments tagged `technical-precision` (alongside sustainability-voice) for the en-gb corpus so this brand voice is represented in the top matches.

## Draft Outline

**Title:** Product Brief: Eco-conscious Women's Winter Sustainable Collection
**Path hint:** `/en-gb/collections/winter-sustainable`

1. **Introduction** **NEW**
   - Rationale: This section will briefly introduce the eco-conscious collection, highlighting its unique selling points and potential market appeal.
   - Sourcing hint: Create a 150-word en-gb intro fragment that encompasses the brand's values, unique features, and target audience.

2. **Collection Highlights** **NEW**
   - Rationale: This section will provide a detailed overview of the key products in the collection, including their care instructions, sourcing stories, and seasonal styling tips.
   - Sourcing hint: Write a 300-word en-gb body fragment that includes comprehensive details on each product, focusing on their innovative care solutions and sustainability aspects.

3. **Care Instructions That Extend Garment Life** **NEW**
   - Rationale: This section will provide detailed care instructions for each product in the collection, highlighting their unique care needs and extended life benefits.
   - Sourcing hint: Write a 200-word en-gb care-guide fragment that covers the care instructions for all products, focusing on extended garment life and sustainability elements.

4. **Sourcing Story: Recycled Materials in Resort Wear** **NEW**
   - Rationale: This section will provide a comprehensive sourcing story for recycled materials in resort wear, highlighting the challenges faced and innovative solutions employed.
   - Sourcing hint: Write a 300-word en-gb source-story fragment that details the sourcing process for recycled materials, including ethical considerations and innovative solutions.
```

## How to read this output

- **Top block (`matchedFragments`).** The three highest-scoring en-gb
  fragments after locale, brand, and hybrid-score filtering. Scores are the
  fused `0.6·cosine + 0.3·bm25 + 0.1·freshness`. Reasons are deterministically
  derived from the score breakdown — no LLM involvement.
- **Middle block (`gaps`).** Each of the brief's three required topics gets
  exactly one verdict (`none` or `partial`). The model returns the description
  and any partial-match ids; the agent appends one structural gap per missing
  brand guideline and one per locale relaxation (none in this run — the corpus
  has en-gb coverage, so locale was not relaxed).
- **Bottom block (`draftOutline`).** 4–6 sections, each `kind: "reuse"` (with
  `fragmentIds` strictly from the top block) or `kind: "new"` (with a
  `sourcingHint` that should echo a gap's `suggestedAction`). In this run the
  model chose all-NEW; a stronger chat model typically reuses one or two of the
  matched fragments instead.

A `**NEW**` marker in the Markdown output corresponds to a `kind: "new"` section
in the JSON — the same `SectionUnion` discriminator in
`shared/src/schema/output.js`.
