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
120 fragments across `en-gb`, `fr-fr`, `de-de`).

Each successful run also persists the rendered output to
`runs/agent/<ISO-timestamp>-winter-sustainable.<md|json>` (override with
`--results-dir=<path>`); the saved bytes match stdout exactly.

> **Note.** Body text (gap descriptions, outline rationale) is LLM-generated
> and therefore drifts run-to-run. The schema, the `matchedFragments` block,
> and the structural locale / brand gaps are deterministic.
>
> The transcript below was captured with chat model `qwen2.5-coder:1.5b`
> (the shipped default is `qwen3.5:9b`, with `gemma4:26b` available as a
> premium alternative for hardware that can sustain it - swap either via
> `config/models.json`). The JSON block was captured in a single invocation;
> the Markdown block is the canonical render of that same JSON via
> `discovery-agent/src/render/markdown.js`.

## Output - Markdown (default)

```markdown
## Top 3 Matching Content Fragments

| # | id | path | score | reason |
|---|----|------|-------|--------|
| 1 | <a id="frag_039"></a>`frag_039` | `/content/dam/aemcontentdisc/en-gb/frag_039` | 0.635 | Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content |
| 2 | <a id="frag_146"></a>`frag_146` | `/content/dam/aemcontentdisc/en-gb/frag_146` | 0.587 | Partial semantic match; strong keyword overlap; brand: sustainability-voice; older content |
| 3 | <a id="frag_001"></a>`frag_001` | `/content/dam/aemcontentdisc/en-gb/frag_001` | 0.570 | Partial semantic match; strong keyword overlap; brand: sustainability-voice; fresh content |

## Gap Analysis

### Coverage: partial

#### recycled materials sourcing

While specific fragments mention recycled items and circular fashion, the content lacks a comprehensive guide detailing
the entire sustainable material sourcing process from initial procurement to final garment use.

- Partial matches: [`frag_001`](#frag_001), [`frag_005`](#frag_005)
- Suggested action: Write a 200-word en-gb product-story fragment covering "recycled materials sourcing", applying
  sustainability-voice.

#### garment care instructions

Multiple fragments address stains and general garment longevity (especially for delicate items), but the pool lacks a
comprehensive 'all-purpose' guide covering the full range of clothing types, including washing techniques for common
materials like denim or silk.

- Partial matches: [`frag_146`](#frag_146), [`frag_197`](#frag_197), [`frag_167`](#frag_167), [`frag_003`](#frag_003)
- Suggested action: Write a 200-word en-gb care-guide fragment covering "garment care instructions", applying
  sustainability-voice.

#### seasonal styling tips

There is strong coverage for seasonal transitions and specific event styling (like garden parties), yet the content
lacks general, actionable 'How-To' guides covering broad wardrobe concepts or how to style outfits throughout all four
seasons.

- Partial matches: [`frag_151`](#frag_151), [`frag_039`](#frag_039), [`frag_156`](#frag_156), [`frag_135`](#frag_135)
- Suggested action: Write a 200-word en-gb seasonal-campaign fragment covering "seasonal styling tips", applying
  sustainability-voice.

## Draft Outline

**Title:** Sustainable Winter Outerwear for the Eco-Conscious Woman
**Path hint:** `/en-gb/collections/winter-sustainable`

1. **Crafted with Conscience: Our Recycled Materials Story** **NEW**
  - Rationale: Addressing the need for a comprehensive guide detailing sustainable material sourcing, fulfilling a
    required topic and gap.
  - Sourcing hint: Write a 200-word en-gb product-story fragment covering "recycled materials sourcing", applying
    sustainability-voice.

2. **Explore Our Latest Winter Outerwear Collection**
  - Reuse: [`frag_001`](#frag_001)
  - Rationale: Uses the most relevant fragment discussing sustainable outerwear (recycled wool/insulation) to introduce
    the collection.

3. **Seasonal Styling: Tips for Year-Round Wardrobe Magic** **NEW**
  - Rationale: Fulfilling the required topic of general styling tips, which is currently lacking broad 'How-To'
    coverage.
  - Sourcing hint: Write a 200-word en-gb seasonal-campaign fragment covering "seasonal styling tips", applying
    sustainability-voice.

4. **Maintaining Your Wardrobe: Expert Care Guides** **NEW**
  - Rationale: Providing an actionable 'all-purpose' guide on garment care, which is a critical gap despite existing
    fragments on stains.
  - Sourcing hint: Write a 200-word en-gb care-guide fragment covering "garment care instructions", applying
    sustainability-voice.

## Reused Fragments

### `frag_001` - Women's winter coats - recycled wool and sustainable insulation

<a id="appendix-frag_001"></a>

- Path: `/content/dam/aemcontentdisc/en-gb/frag_001`
- Category: product-story
- Locale: en-gb
- Brand guidelines: sustainability-voice, inclusive-language
- Last modified: 2026-04-29T06:19:40.946Z

The enduring elegance of true craftsmanship lies in its commitment to both form and conscience. Our latest collection of
women's outerwear reflects this philosophy, offering exceptional warmth without compromise. We have meticulously
reimagined the traditional silhouette of the winter coat, paying homage to centuries of durable tailoring while
embracing modern material science. At the core of these pieces is a beautiful blend of premium recycled wool; a
conscious choice that not only diverts valuable fibres from waste streams but also retains the rich texture and inherent
strength for which natural wool is celebrated. This careful use of recycled wool ensures that every coat carries forward
a renewed story of resilience. Complementing this exquisite textile are linings utilising responsibly sourced
insulation, materials selected after rigorous vetting to minimise environmental impact. These sustainable fillings
provide superior thermal performance, ensuring warmth travels with you through the harshest Nordic winters. More than
merely functional garments, these women's winter coats are considered investments-pieces built for longevity, designed
to become cherished staples of a thoughtful wardrobe for years to come.
```

## How to read this output

- **Top block (`matchedFragments`).** The three highest-scoring en-gb
  fragments after locale, brand, and hybrid-score filtering. Scores are the
  fused `0.6·cosine + 0.3·bm25 + 0.1·freshness`. Reasons are deterministically
  derived from the score breakdown - no LLM involvement.
- **Middle block (`gaps`).** Each of the brief's three required topics gets
  exactly one verdict (`none` or `partial`). The model returns the description
  and any partial-match ids; the agent appends one structural gap per missing
  brand guideline and one per locale relaxation (none in this run - the corpus
  has en-gb coverage, so locale was not relaxed).
- **Bottom block (`draftOutline`).** 4–6 sections, each `kind: "reuse"` (with
  `fragmentIds` strictly from the top block) or `kind: "new"` (with a
  `sourcingHint` that should echo a gap's `suggestedAction`). In this run the
  model chose all-NEW; a stronger chat model typically reuses one or two of the
  matched fragments instead.

A `**NEW**` marker in the Markdown output corresponds to a `kind: "new"` section
in the JSON - the same `SectionUnion` discriminator in
`shared/src/schema/output.js`.
