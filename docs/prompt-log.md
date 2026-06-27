# Prompt Log

Verbatim system / user prompt templates used by every LLM call in the agent
pipeline plus the seeder, with notes on the tuning iterations behind each one.

For the auto-generated transcript of every actual chat call (model, duration,
truncated prompt, truncated response) see the root [`prompt-log.md`](../prompt-log.md);
it is appended to by `shared/src/llm/prompt-log.js` on every chat invocation.

The agent calls one chat model and one embedding model:

- Chat: `qwen3.5:9b` (default, configurable per stage via `config/models.json`;
  `gemma4:26b` is supported as a premium alternative when hardware permits)
- Embeddings: `embeddinggemma:300m` (768-d, Matryoshka-truncatable)

All chat calls run with sampling options `{ temperature: 1.0, top_p: 0.95,
top_k: 64 }` and prompt-driven JSON instructions when the stage expects JSON.
The full body construction is in `shared/src/llm/chat.js`.

## Common patterns

- **JSON mode.** Every stage that consumes structured output asks the model
  for a JSON object and parses with `JSON.parse`. On parse failure
  (`LlmJsonParseError`) the wrapper throws and the stage's retry logic kicks
  in.
- **Retry-once-with-error-hint.** Every stage that calls the model wraps the
  call in a retry helper that, on the first `LlmJsonParseError` or
  `z.ZodError`, appends the exact validation message to the system prompt and
  calls again. Two failures bubble up.
- **Schema-coupled prompts.** Every JSON prompt explicitly enumerates the
  expected JSON shape inside the prompt — the prompt and the Zod schema are kept
  in lockstep so the model sees the same field names it must produce.

## Stage 1 — `parseBrief`

Source: `discovery-agent/src/pipeline/parseBrief.js`.

### System prompt (verbatim)

```
You parse free-form content briefs into strict JSON.

Return ONLY a JSON object with these fields:
- audience: short string describing the target audience.
- locale: one of "en-gb", "fr-fr", "de-de". Infer from country/region in the audience when no URL is present.
- tone: short string describing the desired tone (e.g. "premium", "casual", "technical").
- brandGuidelines: array of strings drawn ONLY from this locked vocabulary: ["sustainability-voice","premium-tone","inclusive-language","technical-precision"]. Include only those that clearly apply.
- requiredTopics: array of 2-6 short topic labels the page must cover.
- pathHint: suggested URL path (e.g. "/en-gb/collections/winter-sustainable"); empty string if not derivable.

Do not invent brand guidelines outside the locked vocabulary. Do not add extra fields. Do not wrap the JSON in prose.

<one of these two locale hints appended at runtime>
  A URL/path in the brief indicates locale "{detectedLocale}". Set "locale" to that value.
  No locale was found in any URL/path. Infer locale from the audience description; if ambiguous, use "en-gb".
```

### User prompt

The raw brief text, unmodified.

### Retry suffix (only on first failure)

```
The previous attempt failed validation: {err.message}. Return strict JSON
matching the schema exactly, with no extra fields. requiredTopics must be a
non-empty array of non-empty strings derived from the brief.
```

### Tuning notes

- **Start:** an open-ended brand-guidelines field that asked the model to
  "infer relevant guidelines". The model invented plausible-but-wrong labels
  (`responsible-luxury`, `eco-statement`) that broke the gap analysis's
  exact-string brand comparisons.
- **End:** locked vocabulary baked into the prompt as a JSON array literal.
  Followed up post-LLM by a hard intersection against the same vocabulary on the
  Zod side (out of scope for the prompt but enforced in `analyseGaps`).
- **Locale.** Initially relied on the model alone. After several runs where
  audience text like "Australian shoppers" produced `locale: "en-au"`, a
  pre-detection step in `parseBrief` now extracts any `/{locale}/` segment from
  the brief and force-sets it; the prompt's locale hint paragraph reflects which
  path the agent took.

## Stage 2 — `retrieve`

No chat calls. Vector retrieval calls the embedding model per topic.

### Embedding query template

```js
embed(brief.requiredTopics[i])
```

The topic string is passed verbatim. No template — `embeddinggemma:300m` was
tuned to be robust against short phrases. An earlier iteration prefixed every
topic with `"AEM content fragment about: "` and the retrieval scores got
slightly worse (the prefix tokens shifted the centroid away from the document
embeddings, which are pure body text). Removed.

## Stage 3 — `analyseGaps`

Source: `discovery-agent/src/pipeline/analyseGaps.js`.

### System prompt (verbatim, with `{}` placeholders filled at runtime)

```
You are a content gap auditor for an AEM Content Discovery agent.
Given a structured brief and a pool of candidate Content Fragments, classify EACH required topic from the brief as either:
  - "none" — no fragment in the pool substantively addresses the topic
  - "partial" — at least one fragment touches the topic but coverage is incomplete (wrong locale, shallow, stale, missing brand voice, brand-filter dropped)

Brief: locale={brief.locale}; audience={brief.audience}; tone={brief.tone}; brandGuidelines=[{brief.brandGuidelines.join(", ")}].
Required topics (return one verdict per topic, in the same order):
  1. {topic1}
  2. {topic2}
  …

Return STRICTLY a JSON object of the form { "verdicts": [ ... ] } where each verdict has this schema: { "topic": string, "coverage": "none" | "partial", "description": string (1-2 sentences explaining what is missing), "partialMatches": string[] (fragment ids that partially cover the topic; MUST be empty when coverage=="none"), "rationale": string (1 sentence) }. Provide exactly one verdict per required topic, in the same order as the topics above.
Use ONLY fragment ids that appear in the candidate pool below.
```

### User prompt

```
Candidate pool (JSON):
[
  {
    "id": "frag_001",
    "title": "...",
    "locale": "en-gb",
    "brandGuidelinesApplied": ["premium-tone"],
    "lastModified": "2026-05-11T...",
    "sources": ["matches"],
    "contentHead": "<first 160 chars of body, whitespace-collapsed>"
  },
  …
]
```

### Retry suffix

```
Previous attempt failed validation: {err.message}
Return ONLY a JSON object of the form { "verdicts": [ ... ] } matching the
schema; do not include prose around the JSON.
```

### Tuning notes

- **Start:** prompt asked for `[ ... ]` (bare array). JSON-object mode
  requires a top-level object, so every call failed JSON parse before
  retry. Changed to `{ "verdicts": [...] }`; the legacy bare-array shape is
  still accepted in the Zod union for back-compat with test fixtures.
- **`partialMatches` discipline.** Early outputs frequently returned
  `coverage: "partial"` with an empty `partialMatches` array. The schema accepts
  the empty array, but the agent now sanitises this post-LLM: empty
  `partialMatches` on a `partial` verdict is rewritten to `none`. Documented in
  the prompt for transparency, enforced in `sanitiseVerdict()`.
- **Structural gaps are not in the prompt.** Locale-relaxation gaps and
  missing-brand-guideline gaps are appended deterministically in
  `buildStructuralGaps()`. Not asking the model to identify them keeps the
  output stable and the prompt short.

## Stage 4 — `compose`

Source: `discovery-agent/src/pipeline/compose.js`.

### System prompt (verbatim)

```
You compose a draft page outline for an AEM content brief.
Output STRICT JSON matching this shape:
{ "title": string, "pathHint": string, "sections": Section[] } where 4 <= sections.length <= 6.
Each Section is EXACTLY ONE of these two shapes, never a mix:
  REUSE: { "heading": string, "kind": "reuse", "fragmentIds": string[] (>=1, ONLY ids from matchedFragments below), "rationale": string }
  NEW:   { "heading": string, "kind": "new",   "rationale": string, "sourcingHint": string }
Rules:
- Order sections as they would appear on the page (intro → body → close).
- A reuse section's fragmentIds MUST all reference ids listed under matchedFragments — never invent ids.
- A new section's sourcingHint should typically echo or refine a relevant gap's suggestedAction.
- Do NOT add extra keys. Do NOT mix reuse fields with new fields in the same section.
- Derive the title from the brief's audience + required topics. Set pathHint from the brief's pathHint.
- Return ONLY the JSON object, no prose, no markdown fence.
```

### User prompt

```
{
  "brief": { ...StructuredBrief... },
  "matchedFragments": [
    { "id": "frag_008", "path": "...", "title": "...", "summary": "<first 200 chars of body, whitespace-collapsed>" },
    …
  ],
  "gaps": [ ...Gap[]... ]
}
```

### Retry suffix

```
Previous attempt failed validation: {err.message}
Return ONLY valid JSON matching the schema above.
```

### Tuning notes

- **Discriminated-union sections.** First iteration described one Section shape
  with optional `fragmentIds` and optional `sourcingHint`; the model produced
  hybrid sections (both fields present, neither field populated). Switched to a
  Zod `discriminatedUnion("kind", [ReuseSection, NewSection])` with `.strict()`
  on both branches and rewrote the prompt to enumerate the two shapes
  explicitly with `EXACTLY ONE of`. Hybrid sections stopped immediately.
- **Orphan-id guard.** The model would occasionally invent fragment ids
  (`frag_999`) when no matched fragment fitted the heading. Added a
  `superRefine` on the schema that rejects any `fragmentIds` entry not present
  in `matchedFragments`, and added the "never invent ids" rule to the prompt.
  The schema's error message includes the offending id, which feeds into the
  retry-hint loop.
- **`pathHint` discipline.** The model frequently changed the `pathHint` to
  something like `/winter-sustainable` instead of the brief's full path. The
  agent now overwrites `pathHint` from the brief after parsing, which makes
  the prompt's "Set pathHint from the brief's pathHint" instruction belt-and-
  braces with code.
- **Sections count.** Originally allowed 1–8 in the schema. Tightened the
  prompt to 4–6 because shorter outlines under-specified the page and longer
  ones started repeating headings. The schema still allows up to 8 in case a
  future brief needs the headroom.

## Seeder prompts

Source: `content-seeder/src/templates.js` and `content-seeder/src/generate.js`.

The seeder is a one-shot script that produces realistic Content Fragment bodies
for the corpus. A pool of six system prompts captures different brand voices
(`premium-narrative`, `care-instructional`, `seasonal-aspirational`,
`sustainability-explainer`, `heritage-voice`, `inclusive-modern`). The
`--variation` flag (`low | medium | high`) selects the subset and temperature:

- `low` — `[premium-narrative]`, temperature 0.6
- `medium` — `[premium-narrative, seasonal-aspirational, heritage-voice]`, temperature 1.0 (default)
- `high` — all six voices, temperature 1.2

### Example system prompt (`premium-narrative`)

```
You write aspirational, brand-led narrative copy for a premium fashion house.
Voice is confident, evocative, restrained. Avoid bullet lists; favour flowing
prose.
```

### User prompt (verbatim template)

```
Write the body copy for an AEM Content Fragment.

Topic: {topic.title}
Keywords to weave in naturally: {topic.keywords.join(", ")}
Locale: {locale.label} (write in {locale.language})
Editorial category: {category}
Target audience: {audience}
Brand guidelines applied: {brandGuidelines.join(", ")}

Length: 150-250 words. Hard minimum 100 words.
Return prose only. No markdown, no headings, no bullet lists unless the
category is "care-guide" and steps make the content materially clearer.
Do not restate the title verbatim.
```

Embedding for each generated fragment is computed by `embed(content)` after the
chat call returns, then written to `data/embeddings.db` via the same
`openVectorStore()` interface the agent uses to read it.

## Where the prompts live in code

| Stage         | File                                                  |
|---------------|--------------------------------------------------------|
| parseBrief    | `discovery-agent/src/pipeline/parseBrief.js`           |
| analyseGaps   | `discovery-agent/src/pipeline/analyseGaps.js`          |
| compose       | `discovery-agent/src/pipeline/compose.js`              |
| seeder bodies | `content-seeder/src/templates.js`, `generate.js`       |
| chat wrapper  | `shared/src/llm/chat.js`                               |
| auto-log      | `shared/src/llm/prompt-log.js`                         |
