# LEARNING_GUIDE.md

> A read-it-front-to-back study guide for the **AEM Content Discovery Agent**. Read top to bottom once and you will be
> able to draw the architecture from memory, defend the design choices, and walk an interviewer through any file in
> this repo. Every claim below is grounded in a specific file and line range against current HEAD; spot-check anything
> that surprises you.

## How to use this guide

- Read it front to back **once** - it builds concepts in the same order as the runtime pipeline.
- Each section ends with one or two **"Pop quiz"** prompts. If you can answer them out loud, you understand it.
- The **citations** are not decoration: `path#Lstart-end` ranges are current; open the file alongside the prose.
- For the *why* behind a choice, jump to [`why.md`](why.md) and [`delivery.md`](../delivery.md). For the *what*,
  jump to [`architecture.md`](architecture.md). This guide stitches them together for an interview audience.
- Interview-style Q&A is collected at the very end (Section 19).

## Table of contents

1. [Elevator pitch (60 seconds)](#1-elevator-pitch-60-seconds)
2. [Problem framing & non-goals](#2-problem-framing--non-goals)
3. [Repo map & monorepo layout](#3-repo-map--monorepo-layout)
4. [The runtime pipeline at a glance](#4-the-runtime-pipeline-at-a-glance)
5. [Stage 1 - `parseBrief`](#5-stage-1--parsebrief)
6. [Stage 2 - `retrieve` (hybrid fusion)](#6-stage-2--retrieve-hybrid-fusion)
7. [Stage 3 - `analyseGaps`](#7-stage-3--analysegaps)
8. [Stage 4 - `compose`](#8-stage-4--compose)
9. [Schema-as-contract (Zod)](#9-schema-as-contract-zod)
10. [Vector store: `sqlite-vec`](#10-vector-store-sqlite-vec)
11. [BM25 index](#11-bm25-index)
12. [LLM client layer](#12-llm-client-layer)
13. [Model selection (`config/models.json`)](#13-model-selection-configmodelsjson)
14. [Content seeder (deterministic generation)](#14-content-seeder-deterministic-generation)
15. [Fragment sources (JSON vs AEM)](#15-fragment-sources-json-vs-aem)
16. [Evaluation & full-run harnesses](#16-evaluation--full-run-harnesses)
17. [Testing strategy & test suite organization](#17-testing-strategy--test-suite-organization)
18. [CLI, artifacts & operational concerns](#18-cli-artifacts--operational-concerns)
19. [Interview cheat-sheet - likely questions](#19-interview-cheat-sheet--likely-questions)
20. [Glossary](#20-glossary)

---

## 1. Elevator pitch (60 seconds)

> A Node 22 CLI that turns a free-form editorial brief into a strict, schema-validated `AgentOutput` - top-3 reusable
> AEM Content Fragments, a gap analysis, and a draft page outline - using a local content corpus and local LLMs
> served by LM Studio. The pipeline is four stages (parse → retrieve → analyse → compose), retrieval is a hybrid of
> vector cosine + BM25 + freshness, every stage validates input/output with Zod, and every LLM call is logged to a
> Markdown audit trail. Nothing leaves the laptop.

The framing is reproduced almost verbatim from [`README.md#L1-L9`](../README.md) and
[`architecture.md#L1-L8`](architecture.md). The pipeline diagram lives in the project root `CLAUDE.md`
under **Architecture**.

**Pop quiz.** Name the four pipeline stages and the single object they collectively produce.

---

## 2. Problem framing & non-goals

The agent answers **three questions in one pass**, as stated in
[`architecture.md#L37-L47`](architecture.md):

1. **What can I reuse?** Top-3 fragments with a per-match score and short reason.
2. **What's missing?** Topics required by the brief that the corpus does not cover (or covers only partially), each
   with a concrete next step.
3. **How should I assemble the page?** A draft outline whose sections are strictly either `reuse` (citing fragment
   ids) or `new` (with a sourcing hint).

The output is a **single Zod-validated `AgentOutput` object**; the Markdown renderer is a *view* over that object,
never a parallel implementation - see [`discovery-agent/src/render/markdown.js`](../discovery-agent/src/render/markdown.js)
and the schema at [`shared/src/schema/output.js#L48-L55`](../shared/src/schema/output.js).

**Non-goals (explicit):**

- No production AEM round-trip yet - the `--source=aem` path and the seeder's AEM push step are marked
  *work-in-progress* in [`README.md#L8-L9`](../README.md).
- No remote LLMs. Everything runs against LM Studio at `http://localhost:1234`
  ([`shared/src/llm/llm.js#L11`](../shared/src/llm/llm.js)).
- No lint/format step - only `node --check` syntax validation, per `CLAUDE.md` ("There is **no lint or format
  step**").

**Pop quiz.** Why is "the renderer is a view over `AgentOutput`" worth saying out loud?

---

## 3. Repo map & monorepo layout

Three npm workspaces, declared in [`package.json#L9-L13`](../package.json):

| Workspace          | Role                                                                | Imported as          |
|--------------------|---------------------------------------------------------------------|----------------------|
| `shared/`          | Zod schemas, LM Studio client, AEM client, retrieval primitives     | `@aemdisc/shared`    |
| `content-seeder/`  | Deterministic corpus generator + sole writer to `data/embeddings.db`| (CLI only)           |
| `discovery-agent/` | The runtime CLI + 4-stage pipeline                                  | (CLI only)           |

Everything `shared/` re-exports is collected in
[`shared/src/index.js#L1-L9`](../shared/src/index.js): schemas, config, llm, aem, sources, retrieve. That is the only
public surface for the two consumer workspaces.

Top-level scripts in [`package.json#L14-L21`](../package.json) match the headlines in `CLAUDE.md`:

- `npm run seed` → generate `data/corpus.json` (Step 1)
- `npm run embed` → embed corpus into `data/embeddings.db` (Step 2)
- `npm run agent eval/briefs/<brief>.txt` → run the pipeline
- `npm run eval` → precision@3 / recall@3 / gap-F1 across 20 briefs
- `npm run full-run` → run every brief and capture `runs/full-run/` artifacts
- `npm test` → all workspace test suites via `node --test`

**Pop quiz.** Which workspace owns writes to `data/embeddings.db`, and where is that policy enforced in code?
(Answer in §10.)

---

## 4. The runtime pipeline at a glance

The flow is documented in `CLAUDE.md` under **Architecture**:

```
brief.txt → parseBrief → retrieve → analyseGaps → compose → AgentOutput
              (LLM)       (embed +      (LLM)        (LLM)
                           BM25 +
                           freshness)
```

All four stages live in [`discovery-agent/src/pipeline/`](../discovery-agent/src/pipeline). The orchestrator is
[`runPipeline` at `discovery-agent/src/cli.js#L96-L115`](../discovery-agent/src/cli.js): it dynamic-imports each stage
(so tests can inject fakes via `deps`), threads `localeOverride` between `parseBrief` and `retrieve`, and returns
the final `compose` result.

Key invariants to memorise:

- **Three LLM chat calls per run** (`parseBrief`, `analyseGaps`, `compose`). `retrieve` itself does **not** call
  chat - it only calls the embedding endpoint, once per `requiredTopic`.
- **`k = 3`** by default; the CLI exposes `--top` (1..10) for debugging only
  ([`discovery-agent/src/cli.js#L87-L94`](../discovery-agent/src/cli.js)).
- The final object is parsed with `AgentOutput.parse(...)` inside
  [`compose` at `discovery-agent/src/pipeline/compose.js#L135-L143`](../discovery-agent/src/pipeline/compose.js) -
  schema validation is the last thing that happens.

**Pop quiz.** How many chat completions does one `npm run agent` invocation make in the happy path? (Three.)

---

## 5. Stage 1 - `parseBrief`

Source: [`discovery-agent/src/pipeline/parseBrief.js`](../discovery-agent/src/pipeline/parseBrief.js).

**Input:** the raw brief text (file or stdin). **Output:** a `StructuredBrief` validated against
[`shared/src/schema/brief.js#L3-L11`](../shared/src/schema/brief.js):

```
{ audience, locale, tone, brandGuidelines[], requiredTopics[≥1], pathHint, uncertain? }
```

Things to remember:

- The system prompt locks a **controlled vocabulary** for brand guidelines -
  [`BRAND_VOCAB` at `parseBrief.js#L12-L17`](../discovery-agent/src/pipeline/parseBrief.js): `sustainability-voice`,
  `premium-tone`, `inclusive-language`, `technical-precision`. The prompt explicitly says "Do not invent brand
  guidelines outside the locked vocabulary" ([`parseBrief.js#L29`](../discovery-agent/src/pipeline/parseBrief.js)).
- **Locale precedence:** a URL/path locale found in the brief text wins over whatever the model returns. See
  [`detectLocaleFromPath` and the post-hoc reconciliation at `parseBrief.js#L31-L34, L85-L93`](../discovery-agent/src/pipeline/parseBrief.js).
  If the model invents an unknown locale and no path hint exists, it falls back to `en-gb` and pushes a note onto
  `brief.uncertain[]`.
- **Retry policy is the caller's responsibility:** `LlmJsonParseError` and `ZodError` trigger up to **two** extra
  attempts with progressively stricter system prompts
  ([`parseBrief.js#L68-L81`](../discovery-agent/src/pipeline/parseBrief.js)). This mirrors the rule in `CLAUDE.md`
  LLM-layer notes that `JsonParseError` retry is **not** done inside `llmFetch`.
- Chat options used: `json: true`, `num_predict: 2500`
  (`PARSE_BRIEF_NUM_PREDICT` at [`parseBrief.js#L40`](../discovery-agent/src/pipeline/parseBrief.js)).

**Pop quiz.** What happens if the LLM returns a `locale` field that disagrees with a URL in the brief?

---

## 6. Stage 2 - `retrieve` (hybrid fusion)

Source: [`discovery-agent/src/pipeline/retrieve.js`](../discovery-agent/src/pipeline/retrieve.js). **This is the most
likely deep-dive question in an interview.** Memorise the constants:

- **Weights:** `cosine: 0.6, bm25: 0.3, freshness: 0.1` -
  [`retrieve.js#L10`](../discovery-agent/src/pipeline/retrieve.js).
- **Per-query top-k pool:** `TOP_PER_QUERY = 15` -
  [`retrieve.js#L8`](../discovery-agent/src/pipeline/retrieve.js).
- **Freshness horizon:** 18 months - [`retrieve.js#L9`](../discovery-agent/src/pipeline/retrieve.js); the score is
  `clamp01(1 − months/18)` ([`freshnessScore` at `retrieve.js#L20-L26`](../discovery-agent/src/pipeline/retrieve.js)).
- **Default `k` returned to the caller:** 3.

### The algorithm, step by step

For each `topic` in `brief.requiredTopics` ([`retrieve.js#L95-L127`](../discovery-agent/src/pipeline/retrieve.js)):

1. Embed the topic via `embedImpl(topic)` and ask the vector store for the 15 nearest neighbours, filtered to the
   current locale-ladder candidate set ([`retrieve.js#L96-L103`](../discovery-agent/src/pipeline/retrieve.js)).
2. Run a BM25 search over the same candidates with `bm25.searchByText(topic, { k: 15, filterIds })`
   ([`retrieve.js#L104-L107`](../discovery-agent/src/pipeline/retrieve.js)).
3. **Normalise BM25** to `[0, 1]` by dividing by the per-query maximum
   ([`normaliseBm25` at `retrieve.js#L61-L67`](../discovery-agent/src/pipeline/retrieve.js)). Cosine is already clamped
   into `[0, 1]` by the vector store.
4. Fuse: `score = clamp01(0.6·cosine + 0.3·bm25 + 0.1·freshness)`
   ([`retrieve.js#L121`](../discovery-agent/src/pipeline/retrieve.js)).
5. Keep the **best** score per fragment across all topic queries
   ([`retrieve.js#L122-L126`](../discovery-agent/src/pipeline/retrieve.js)) - fragments retrieved by multiple topics
   are not double-counted; only their winning topic survives.

### Locale ladder

`applyLocaleLadder` ([`retrieve.js#L28-L35`](../discovery-agent/src/pipeline/retrieve.js)) is a three-rung fallback
applied to the corpus **before** any scoring happens:

1. **Exact** - `fragment.locale === brief.locale`. If anything matches, stop here.
2. **Prefix** - share the language prefix (e.g. an `en-gb` brief will accept any `en-*` fragment).
3. **Any** - fall back to the full corpus.

The chosen rung is returned as `localeRelaxed: false | "prefix" | "any"`, and `analyseGaps` later emits a
**structural gap** when the ladder relaxed below "exact"
([`analyseGaps.js#L161-L176`](../discovery-agent/src/pipeline/analyseGaps.js)).

### Brand-guideline filter

`brandOverlap` ([`retrieve.js#L37-L42`](../discovery-agent/src/pipeline/retrieve.js)) is **post-hoc**: a candidate
survives only if it shares at least one brand guideline with the brief. Dropped candidates are surfaced separately
on `retrievalResult.droppedByBrandFilter` so `analyseGaps` can reason about them
([`retrieve.js#L129-L153`](../discovery-agent/src/pipeline/retrieve.js)).

### Reason strings

`buildReason` ([`retrieve.js#L44-L59`](../discovery-agent/src/pipeline/retrieve.js)) composes a ≤140-character
explanation from breakdown thresholds (`cosine ≥ 0.6` → "strong semantic match", etc.), brand overlap, freshness
buckets, and the locale-ladder mode. The 140-char cap matches the `MatchedFragment.reason` Zod constraint at
[`shared/src/schema/output.js#L9`](../shared/src/schema/output.js).

### Return shape

```
{ matches[≤k], nearMisses[k..15], droppedByBrandFilter[], localeRelaxed, vectorSearchAvailable }
```

When the source is `AemFragmentSource`, vector search is bypassed entirely
([`retrieve.js#L75-L82`](../discovery-agent/src/pipeline/retrieve.js)) - AEM mode is **BM25-only**, by design,
because the AEM source ships no vector index.

**Pop quiz.** A brief asks for `fr-fr` but only `en-gb` and `de-de` fragments exist. What does retrieval return and
what gap does `analyseGaps` emit?

---

## 7. Stage 3 - `analyseGaps`

Source: [`discovery-agent/src/pipeline/analyseGaps.js`](../discovery-agent/src/pipeline/analyseGaps.js).

The LLM acts as a **judge** that reads the brief and a candidate **pool** (matches + nearMisses + brand-dropped
fragments, deduplicated, [`buildPool` at `analyseGaps.js#L45-L60`](../discovery-agent/src/pipeline/analyseGaps.js))
and assigns each required topic a `coverage` of `"none"` or `"partial"`.

Validation is layered:

- Each verdict is a `TopicVerdict` Zod object
  ([`analyseGaps.js#L10-L16`](../discovery-agent/src/pipeline/analyseGaps.js)).
- The judge may return either `{ verdicts: [...] }` or a bare array - both shapes are accepted
  ([`JudgeOutput` at `analyseGaps.js#L20-L23`](../discovery-agent/src/pipeline/analyseGaps.js)).
- After parsing, `sanitiseVerdict` ([`analyseGaps.js#L143-L155`](../discovery-agent/src/pipeline/analyseGaps.js))
  strips any `partialMatches` id that is not in the pool, downgrades `partial` → `none` when no partial matches
  survive, and clears `partialMatches` when coverage is `none`. This is a **belt-and-braces guard** against
  hallucinated fragment ids.

Two classes of gap are produced:

1. **LLM-judged gaps** - one per required topic, with a `suggestedAction` synthesised deterministically by
   `suggestedActionForTopic` ([`analyseGaps.js#L69-L75`](../discovery-agent/src/pipeline/analyseGaps.js)). The category
   is inferred from keywords (`care/wash/repair/longevity` → `care-guide`, etc., in
   [`inferCategory` at `analyseGaps.js#L62-L67`](../discovery-agent/src/pipeline/analyseGaps.js)).
2. **Structural gaps** - generated by `buildStructuralGaps`
   ([`analyseGaps.js#L157-L204`](../discovery-agent/src/pipeline/analyseGaps.js)):
   - "Locale-appropriate content for `<brief.locale>`" whenever `retrievalResult.localeRelaxed` is truthy.
   - "Brand guideline coverage: `<guideline>`" for each brief brand guideline that no top match applies.

Both types are finally re-validated against [`Gap` schema](../shared/src/schema/output.js) at
[`analyseGaps.js#L245`](../discovery-agent/src/pipeline/analyseGaps.js).

Retry mirror image of `parseBrief`: a single retry with an augmented system prompt if the judge returned bad JSON
or a Zod-invalid shape ([`analyseGaps.js#L132-L140`](../discovery-agent/src/pipeline/analyseGaps.js)). Chat options:
`json: true`, `num_predict: 4000` ([`analyseGaps.js#L30`](../discovery-agent/src/pipeline/analyseGaps.js)).

**Pop quiz.** What is the difference between an LLM-judged gap and a structural gap, and where in the code is each
emitted?

---

## 8. Stage 4 - `compose`

Source: [`discovery-agent/src/pipeline/compose.js`](../discovery-agent/src/pipeline/compose.js).

Composes the final `DraftOutline` (4–6 sections, validated against
[`shared/src/schema/output.js#L42-L46`](../shared/src/schema/output.js)) and assembles the full `AgentOutput`.

Two non-obvious invariants here:

1. **Orphan-fragment guard.** Before parsing the LLM's outline, `buildOrphanCheckedSchema`
   ([`compose.js#L46-L62`](../discovery-agent/src/pipeline/compose.js)) wraps `DraftOutline` with a Zod
   `superRefine` that rejects any `fragmentIds` value not in the `matchedFragments` set. This is the only
   defence against the model inventing a fragment id that doesn't exist.
2. **Strict section discriminated union.** `ReuseSection` and `NewSection` use `.strict()` so extra keys are
   rejected ([`shared/src/schema/output.js#L22-L40`](../shared/src/schema/output.js)). The system prompt is explicit
   about this: "Each Section is EXACTLY ONE of these two shapes, never a mix"
   ([`compose.js#L17`](../discovery-agent/src/pipeline/compose.js)).

The retry policy is **one** retry on `LlmJsonParseError` or `ZodError`, with the error message embedded in the
augmented system prompt ([`callOutlineWithRetry` at `compose.js#L64-L98`](../discovery-agent/src/pipeline/compose.js)).
On the second failure the error is logged with `console.error` and re-thrown - per the spec, this is the **last**
LLM call and a failure is loud.

After validation, `compose` overrides `pathHint` with the brief's pathHint when present
([`compose.js#L129-L131`](../discovery-agent/src/pipeline/compose.js)) and reconstructs `reusedFragments` by walking
the outline's `reuse` sections in order ([`collectReusedFragments` at
`compose.js#L145-L163`](../discovery-agent/src/pipeline/compose.js)).

Final shape (always - [`compose.js#L135-L143`](../discovery-agent/src/pipeline/compose.js)):

```
AgentOutput {
  schemaVersion: "1.0",
  brief, matchedFragments[≤3], gaps[], draftOutline, reusedFragments
}
```

Chat options: `json: true`, `num_predict: 6000` ([`compose.js#L11`](../discovery-agent/src/pipeline/compose.js)).

**Pop quiz.** A model returns `fragmentIds: ["frag_999"]` and no fragment with that id exists. Which line of code
catches it and what error is thrown?

---

## 9. Schema-as-contract (Zod)

Every cross-stage payload is a Zod object in [`shared/src/schema/`](../shared/src/schema). This is the codebase's
single most important architectural decision - repeat it in any interview.

| Schema             | File                                                                       | Used by                                  |
|--------------------|----------------------------------------------------------------------------|------------------------------------------|
| `StructuredBrief`  | [`shared/src/schema/brief.js#L3-L11`](../shared/src/schema/brief.js)          | `parseBrief` → `retrieve`, `analyseGaps` |
| `Fragment`         | [`shared/src/schema/fragment.js#L6-L16`](../shared/src/schema/fragment.js)    | corpus, retrieval pool                   |
| `Corpus`           | [`shared/src/schema/corpus.js#L4-L10`](../shared/src/schema/corpus.js)        | `JsonFragmentSource`, seeder write       |
| `MatchedFragment`  | [`shared/src/schema/output.js#L5-L10`](../shared/src/schema/output.js)        | `compose` output                         |
| `Gap`              | [`shared/src/schema/output.js#L14-L20`](../shared/src/schema/output.js)       | `analyseGaps` output                     |
| `ReuseSection` / `NewSection` / `DraftOutline` | [`shared/src/schema/output.js#L22-L46`](../shared/src/schema/output.js) | `compose` output                       |
| `AgentOutput`      | [`shared/src/schema/output.js#L48-L55`](../shared/src/schema/output.js)       | the final contract                       |

Constants worth knowing by heart:

- `FRAGMENT_CATEGORIES = ["product-story", "care-guide", "seasonal-campaign"]`
  ([`fragment.js#L3`](../shared/src/schema/fragment.js)).
- `FRAGMENT_LOCALES = ["en-gb", "fr-fr", "de-de"]` ([`fragment.js#L4`](../shared/src/schema/fragment.js)).
- `GAP_COVERAGE = ["none", "partial"]` ([`output.js#L12`](../shared/src/schema/output.js)).
- `DraftOutline.sections` is bounded `min(1).max(8)` ([`output.js#L45`](../shared/src/schema/output.js)); the prompt
  asks for 4–6 ([`compose.js#L16`](../discovery-agent/src/pipeline/compose.js)) but the schema is forgiving.
- `MatchedFragment.score` is `[0, 1]`; `reason` is capped at 140 chars
  ([`output.js#L8-L9`](../shared/src/schema/output.js)).
- `Fragment.brandGuidelinesApplied` requires `≥ 1` entry
  ([`fragment.js#L11`](../shared/src/schema/fragment.js)) - the brand filter relies on this being non-empty.

**Pop quiz.** Why does the schema use `z.discriminatedUnion("kind", [...])` for sections instead of a plain union?
(Faster + better error messages; rejects mixed-shape sections at the parser, not in business logic.)

---

## 10. Vector store: `sqlite-vec`

Source: [`shared/src/retrieve/vectorStore.js`](../shared/src/retrieve/vectorStore.js).

The vector store is a `better-sqlite3` database with the
[`sqlite-vec`](https://github.com/asg017/sqlite-vec) extension loaded at runtime
([`vectorStore.js#L20-L21`](../shared/src/retrieve/vectorStore.js)). Two tables:

- `fragments_vec` - a `vec0` virtual table created with
  `CREATE VIRTUAL TABLE fragments_vec USING vec0(embedding float[<dims>])`
  ([`content-seeder/src/embeddings.js#L16-L18`](../content-seeder/src/embeddings.js)).
- `fragments_meta` - a normal SQLite table keyed by the same `rowid`, storing `id, locale, category, title`
  ([`embeddings.js#L19-L27`](../content-seeder/src/embeddings.js)).

**Read/write separation is enforced in code, not just convention:** the runtime store opens the DB with
`{ readonly: true }` ([`vectorStore.js#L20`](../shared/src/retrieve/vectorStore.js)). The seeder is therefore the
**only writer** - restating the rule in `CLAUDE.md`.

`searchByVector` ([`vectorStore.js#L23-L46`](../shared/src/retrieve/vectorStore.js)) runs a single SQL query:

```sql
SELECT m.id AS id, vec_distance_cosine(v.embedding, ?) AS distance
FROM fragments_vec v
JOIN fragments_meta m ON m.rowid = v.rowid
ORDER BY distance ASC
```

`distance` (cosine distance) is converted to a similarity with `1 − distance`, then clamped to `[0, 1]`
([`vectorStore.js#L42`](../shared/src/retrieve/vectorStore.js)). Filtering by `filterIds` happens **after** ordering,
which is acceptable here because the corpus is small (hundreds of fragments, not millions).

If `data/embeddings.db` is missing, opening throws with the friendly hint
`VECTOR_DB_MISSING_HINT = "data/embeddings.db not found - run 'npm run seed' first"`
([`vectorStore.js#L5-L6, L17-L19`](../shared/src/retrieve/vectorStore.js)).

**Pop quiz.** Why does the seeder use `BigInt(row.rowid)` when inserting?
([`embeddings.js#L51-L58`](../content-seeder/src/embeddings.js) - sqlite-vec virtual tables require a true integer
rowid; BigInt is the safest way to bind it as `INTEGER` in better-sqlite3.)

---

## 11. BM25 index

Source: [`shared/src/retrieve/bm25.js`](../shared/src/retrieve/bm25.js).

In-memory only, backed by
[`wink-bm25-text-search`](https://www.npmjs.com/package/wink-bm25-text-search) - the index is rebuilt per request
inside `retrieve` ([`retrieve.js#L90`](../discovery-agent/src/pipeline/retrieve.js)). Three details:

- **Field weights:** `title: 3, content: 1, targetAudience: 1`
  ([`bm25.js#L20-L22`](../shared/src/retrieve/bm25.js)). Title hits are worth three body hits.
- **Tokeniser:** lowercase, ASCII-only `[a-z0-9-]`, drops 1-character tokens and a 26-word English stop list
  ([`bm25.js#L3-L16`](../shared/src/retrieve/bm25.js)). That stop list is **English-only**, which is a deliberate
  tradeoff documented in `why.md` and means BM25 contributes little signal for `fr-fr` and `de-de` queries -
  vector embeddings carry the multilingual weight.
- **Cold-start guard:** the engine refuses to consolidate (and `searchByText` returns `[]`) when fewer than 3
  documents are present ([`bm25.js#L38-L45`](../shared/src/retrieve/bm25.js)). Tests with tiny fixtures rely on this.

**Pop quiz.** What is the implication of the stop-word list being English-only for the locale ladder?

---

## 12. LLM client layer

Source: [`shared/src/llm/`](../shared/src/llm). Five files, each with one job:

| File                                                                         | Job                                                |
|------------------------------------------------------------------------------|----------------------------------------------------|
| [`shared/src/llm/llm.js`](../shared/src/llm/llm.js)                             | host resolution, `llmFetch` with retry + classification |
| [`shared/src/llm/chat.js`](../shared/src/llm/chat.js)                           | `/v1/chat/completions`, `<think>` handling, JSON parse |
| [`shared/src/llm/embed.js`](../shared/src/llm/embed.js)                         | `/v1/embeddings`, single + batch                   |
| [`shared/src/llm/errors.js`](../shared/src/llm/errors.js)                       | seven typed error classes                          |
| [`shared/src/llm/prompt-log.js`](../shared/src/llm/prompt-log.js)               | append every call to `runtime-prompt-log.md`  |

### `llmFetch` - error classification (memorise this)

[`shared/src/llm/llm.js#L49-L129`](../shared/src/llm/llm.js) is the only place that talks to the network. It maps
failures onto seven typed errors defined in
[`shared/src/llm/errors.js#L25-L31`](../shared/src/llm/errors.js):

| Error class                  | When                                                                              | Retried inside `llmFetch`? |
|------------------------------|-----------------------------------------------------------------------------------|----------------------------|
| `LlmUnavailableError`        | fetch threw (server down, refused connection)                                     | **Yes** (1 retry)          |
| `LlmServerError`             | HTTP 5xx; or any non-OK status not matching the more-specific cases below          | **Yes if 5xx** (1 retry)   |
| `LlmTimeoutError`            | `AbortController` fired (timeout)                                                 | No                         |
| `LlmModelNotFoundError`      | HTTP 404 or body matches `/model .* not found|pull the model|no such model/i`     | No                         |
| `LlmContextOverflowError`    | body matches `/context length|context window|too many tokens|exceeds context/i`   | No                         |
| `LlmJsonParseError`          | thrown by `chat.js` when `JSON.parse` fails on the model reply                    | No - **caller** retries    |
| `LlmInvariantError`          | empty response, malformed shape, truncated mid-`<think>`                          | No                         |

The retry decision policy is `CLAUDE.md`-pinned: only `Unavailable` and 5xx `Server` errors retry inside the
client; `JsonParseError` is the caller's problem (see `parseBrief`, `analyseGaps`, `compose` retry sites).

### `chat` quirks worth knowing

- **`<think>` stripping.** A leading `<think>...</think>` block from thinking models (qwen3) is stripped silently
  ([`chat.js#L24-L25, L90-L94`](../shared/src/llm/chat.js)). A `<think>` that never closes throws
  `LlmInvariantError` with the message "Response truncated mid-think - increase max_tokens"
  ([`chat.js#L95-L100`](../shared/src/llm/chat.js)).
- **Markdown-fence stripping for JSON.** Gemma sometimes wraps JSON in ```` ```json ... ``` ````; `chat.js` strips
  that fence before parsing ([`chat.js#L113-L115`](../shared/src/llm/chat.js)).
- **Options shape.** Legacy `num_predict` → OpenAI-compat `max_tokens`
  ([`chat.js#L53-L63`](../shared/src/llm/chat.js)). No `response_format` is sent - LM Studio's `json_schema` mode is
  bypassed in favour of prompt instructions + `JSON.parse` (comment at
  [`chat.js#L64`](../shared/src/llm/chat.js)).
- **Timeout.** Default `CHAT_TIMEOUT_MS = 120_000`; override via env
  ([`chat.js#L10-L18`](../shared/src/llm/chat.js)). The full-run harness bumps it to 5 minutes
  ([`scripts/full-run.js#L19-L20`](../scripts/full-run.js)).

### Prompt log

Every call (success or failure) is appended to `runtime-prompt-log.md` (or `PROMPT_LOG_PATH`)
([`prompt-log.js#L11-L13, L24-L51`](../shared/src/llm/prompt-log.js)). This is the **audit trail** - point to it in
the interview when asked "how would you debug a bad answer?"

**Pop quiz.** A model returns `{"foo": 1` (truncated JSON). What exact error class propagates out of `chat()`, and
is it retried by `llmFetch`?

---

## 13. Model selection (`config/models.json`)

Source: [`shared/src/config/models.js`](../shared/src/config/models.js) (loader) and
[`config/models.json`](../config/models.json) (data).

The current configuration ([`config/models.json#L1-L12`](../config/models.json)):

```json
{
  "chat":      { "default": "google/gemma-4-e4b",
                 "seeder":  "google/gemma-4-e4b",
                 "parseBrief":  "google/gemma-4-e4b",
                 "analyseGaps": "google/gemma-4-e4b",
                 "compose":     "google/gemma-4-e4b" },
  "embedding": { "default": "embeddinggemma-300m" }
}
```

API:

- `getChatModel(stage = "default")` - returns the stage-specific override if present, else `chat.default`
  ([`models.js#L55-L62`](../shared/src/config/models.js)).
- `getEmbeddingModel()` - returns `embedding.default`
  ([`models.js#L64-L67`](../shared/src/config/models.js)).
- The config is loaded **once** and cached; `resetModelsConfigCache()` exists for tests
  ([`models.js#L9, L51, L69-L71`](../shared/src/config/models.js)).

Stage-level overrides keep every LLM call routable to a different model without changing code, while the harness
also accepts `EVAL_CHAT_MODEL` as a runtime override
([`eval/run.js#L27`](../eval/run.js)). The rationale lives in
[`delivery.md`](../delivery.md): one config file, no rebuild, easy to swap to a smaller fallback.

**Pop quiz.** How would you point `compose` at a different model without touching code?

---

## 14. Content seeder (deterministic generation)

Workspace: [`content-seeder/`](../content-seeder). Three commands:

- `npm run seed` → generates fragments
  ([`content-seeder/src/seed.js`](../content-seeder/src/seed.js)).
- `npm run embed` → embeds them into SQLite
  ([`content-seeder/src/embed-cli.js`](../content-seeder/src/embed-cli.js)).
- (WIP) AEM push from [`content-seeder/src/aem-push.js`](../content-seeder/src/aem-push.js).

### Determinism

A single `--seed=<n>` integer drives everything ([`seed.js#L53-L55`](../content-seeder/src/seed.js)). Seeding flows
through two channels:

1. **Mulberry32 PRNG** in [`content-seeder/src/rng.js#L3-L12`](../content-seeder/src/rng.js) - used to pick brand
   guidelines, templates, last-modified offsets, and to shuffle category order. The PRNG is per-locale and
   per-fragment, derived from `(seed + offset)` arithmetic
   ([`generate.js#L100, L125`](../content-seeder/src/generate.js)).
2. **Faker seed** - the locale-appropriate faker (`fakerEN_GB`, `fakerFR`, `fakerDE`) is reseeded with
   `fragmentSeed` before each fragment ([`generate.js#L127`](../content-seeder/src/generate.js)) so audience and
   title flavour are reproducible.

The locked seed used by every eval expectation is **`DEMO_SEED = 20260626`**
([`eval/run.js#L14`](../eval/run.js), [`scripts/full-run.js#L31`](../scripts/full-run.js)).

### Reserved vs random topics

- **Reserved topics** ([`topics.js#L3-L34`](../content-seeder/src/topics.js)) - six fixed entries that guarantee the
  winter-sustainable demo brief has ≥6 retrievable matches per locale. They are rotated per locale by
  `reservedForLocale(localeIndex)` ([`topics.js#L62-L69`](../content-seeder/src/topics.js)) so the order isn't
  identical across locales.
- **Random topics** ([`topics.js#L39-L60`](../content-seeder/src/topics.js)) - a broad pool used for non-reserved
  slots; `topicMatchingCategory` tries up to 6 times to balance categories
  ([`generate.js#L85-L92`](../content-seeder/src/generate.js)).

### Templates / variation

Six system-prompt templates in [`templates.js#L1-L38`](../content-seeder/src/templates.js); `--variation` chooses
which subset and the temperature ([`templates.js#L40-L44`](../content-seeder/src/templates.js)):

- `low` → temperature 0.6, 1 template
- `medium` → 1.0, 3 templates *(default)*
- `high` → 1.2, all 6 templates

### Preflight

Before any generation, `preflightModels` ([`content-seeder/src/preflight.js`](../content-seeder/src/preflight.js))
hits LM Studio's `/v1/models` and verifies every chat model in `config/models.json` is loaded; if `--skip-embeddings`
is `false`, the embedding model is checked too ([`preflight.js#L42-L60`](../content-seeder/src/preflight.js)). A
missing model raises a clear error naming the first missing entry and the configured host.

### Output

`saveCorpus` ([`seed.js#L96-L106`](../content-seeder/src/seed.js)) writes the validated `Corpus` JSON to
`data/corpus.json` and checkpoints after every batch
([`seed.js#L162-L166`](../content-seeder/src/seed.js)), so a half-finished run is still usable. The embedding step is
**off by default** (`--skip-embeddings` defaults to `true`,
[`seed.js#L34`](../content-seeder/src/seed.js)) - you run `npm run embed` separately.

### Embedding step

[`content-seeder/src/embeddings.js`](../content-seeder/src/embeddings.js) detects dimension from the first vector
([`embeddings.js#L36-L40`](../content-seeder/src/embeddings.js)), creates the schema, then inserts every fragment in
a transaction ([`embeddings.js#L43-L77`](../content-seeder/src/embeddings.js)). A dimension mismatch mid-batch is a
fatal `Error` - the corpus must be consistent. `embed-cli.js` also calls `ensureEmbedModelLoaded`
([`embed-cli.js#L71-L89`](../content-seeder/src/embed-cli.js)) to nudge LM Studio to load the model via its
`/api/v1/models/load` endpoint before embedding starts.

**Pop quiz.** Why are the six "reserved topics" needed at all? What would the eval harness do without them?

---

## 15. Fragment sources (JSON vs AEM)

Both implement the same async `load() → { fragments }` interface
([`shared/src/sources/index.js`](../shared/src/sources/index.js)).

- **`JsonFragmentSource`** ([`shared/src/sources/JsonFragmentSource.js`](../shared/src/sources/JsonFragmentSource.js))
  - reads `data/corpus.json`, validates it through `parseCorpus`, returns
  `{ fragments }`. `kind = "json"`. Default for the CLI
  ([`discovery-agent/src/cli.js#L74-L79`](../discovery-agent/src/cli.js)).
- **`AemFragmentSource`** ([`shared/src/sources/AemFragmentSource.js`](../shared/src/sources/AemFragmentSource.js)) -
  wraps an authenticated AEM client and calls `listFragments` from
  [`shared/src/aem/read.js`](../shared/src/aem/read.js). `kind = "aem"`. Activated with `--source=aem`.

`retrieve` uses `kind === "aem"` (or `instanceof AemFragmentSource`) to **skip vector search**
([`retrieve.js#L75-L82`](../discovery-agent/src/pipeline/retrieve.js)) because the AEM source has no companion
embeddings database.

**Pop quiz.** What would you need to add to make the AEM path support vector search?
(A sidecar embeddings index keyed by fragment id, or a switch to a vector-capable AEM/Edge backend; either way,
not a one-line change.)

---

## 16. Evaluation & full-run harnesses

### `npm run eval` - [`eval/run.js`](../eval/run.js)

Scores **20 briefs** in `eval/briefs/` against hand-labelled `eval/expectations/<slug>.json`. The locked seed is
`DEMO_SEED = 20260626` ([`eval/run.js#L14`](../eval/run.js)) - change the seeder and the expectations need
re-labelling.

Three metrics:

- **`precision@3`** - share of returned top-3 ids that appear in `expectedMatchIds`
  ([`precisionRecall` at `run.js#L58-L65`](../eval/run.js)).
- **`recall@3`** - share of `expectedMatchIds` recovered in the top-3.
- **`gap-F1`** - greedy best-cosine pairing of returned vs expected gap topics, gated by matching `coverage`
  and a cosine threshold of **`GAP_COSINE_THRESHOLD = 0.5`** ([`run.js#L23, L75-L117`](../eval/run.js)). The harness
  embeds gap topics through `embed()` to compute that similarity.

Pass/fail threshold defaults to `0.6` on aggregate gap-F1
([`DEFAULT_F1_THRESHOLD` at `run.js#L24, L260-L262`](../eval/run.js)); override with `EVAL_F1_THRESHOLD`. Results are
also written to `eval/latest.json` ([`run.js#L21, L264-L275`](../eval/run.js)).

The harness **never** edits the agent's defaults; instead it wraps `defaultChat` with `makeChat(EVAL_CHAT_MODEL)`
([`run.js#L33-L35`](../eval/run.js)) and passes the wrapped function into each stage.

### `npm run full-run` - [`scripts/full-run.js`](../scripts/full-run.js)

Drives the agent against **every** brief (not just the ones with expectations) and produces:

- `runs/full-run/<slug>.json` + `.md` (latest-overwriting aggregates,
  [`writeBriefArtifacts` at `full-run.js#L151-L166`](../scripts/full-run.js)).
- A timestamped `<ISO>-<slug>.{json,md}` pair using `buildArtifactFilename` from
  [`discovery-agent/src/persistResult.js`](../discovery-agent/src/persistResult.js).
- A `.meta.json` per brief including stage timings, gap counts, retry count, and status (`ok` / `timeout` /
  `error`) ([`writeMeta` and `runBriefWithRetry` at `full-run.js#L168-L241`](../scripts/full-run.js)).
- A top-level `README.md` summary table ([`buildIndexReadme` at
  `full-run.js#L243-L270`](../scripts/full-run.js)).

Two safety nets unique to full-run:

1. **Corpus precheck** ([`corpusPrecheck` at `full-run.js#L68-L89`](../scripts/full-run.js)) - refuses to run unless
   `data/corpus.json` exists, has ≥24 fragments, and covers all three required locales. Aborts with an actionable
   error otherwise.
2. **One retry per brief** ([`runBriefWithRetry` at `full-run.js#L176-L241`](../scripts/full-run.js)) - re-runs once
   on failure, classifies the second failure as `"timeout"` or `"error"`, and never throws.

**Pop quiz.** How does the harness distinguish a brief that timed out from one that schema-failed in `compose`?

---

## 17. Testing strategy & test suite organization

The repo has **no lint or format step** (only `node --check` for syntax) - so the test suite carries the
whole quality bar. Tests live next to the workspace they exercise; everything runs through the **`node:test`**
runner.

### Runner & layout

```
package.json "test": node --test --test-reporter spec
  'shared/test/**/*.test.js'
  'content-seeder/test/**/*.test.js'
  'discovery-agent/test/**/*.test.js'
  'scripts/test/**/*.test.js'
```

Four test roots, mirroring the three workspaces plus the `scripts/` harness driver:

| Root | Files | Tests | Focus |
|------|-------|-------|-------|
| [`shared/test/`](../shared/test) | 6 | 77 | Schemas, retrieval primitives, LLM client + error taxonomy, model config, AEM client, barrel exports |
| [`discovery-agent/test/`](../discovery-agent/test) | 6 | 59 | The four pipeline stages, CLI flag parsing, markdown rendering, retrieve integration with fixture corpora |
| [`content-seeder/test/`](../content-seeder/test) | 4 | 27 | Determinism of `planFragments`, embeddings DB write, Sling-POST push, model preflight |
| [`scripts/test/`](../scripts/test) | 1 | 18 | `full-run` harness wiring: corpus precheck, retry, README aggregation, stage instrumentation |
| **Total** | **17** | **181** | |

`npm test` runs all four roots in one invocation. A single root can be run on its own - useful while iterating:

```bash
node --test --test-reporter spec 'shared/test/**/*.test.js'
```

### What each file covers

**`shared/test/`**

- [`schema.test.js`](../shared/test/schema.test.js) - every Zod schema (Fragment, Corpus, StructuredBrief,
  MatchedFragment, Gap, SectionUnion, AgentOutput). Includes happy-path parses + every refinement: locale enum,
  brand-vocab enum, `schemaVersion === "1.0"`, `matchedFragments[0..3]`, `draftOutline.sections[1..8]`, the
  `superRefine` discriminated union on `kind: "reuse" | "new"`.
- [`retrieve.test.js`](../shared/test/retrieve.test.js) - the low-level retrieval primitives without the
  `retrieve()` pipeline orchestration. Builds a real on-disk `sqlite-vec` DB inside `mkdtemp()`, then asserts
  cosine ordering, BM25 ranking, and `VECTOR_DB_MISSING_HINT` when the DB is absent.
- [`llm.test.js`](../shared/test/llm.test.js) - all 22 tests around the LLM client: `chat`, `embed`,
  `appendPromptLog`, `getHost`, `llmFetch`, plus each of the **7 error classes** (`LlmUnavailableError`,
  `LlmServerError`, `LlmTimeoutError`, `LlmModelNotFoundError`, `LlmJsonParseError`, `LlmContextOverflowError`,
  `LlmInvariantError`) and `truncateHead`. Mocks `global.fetch` per `beforeEach`/`afterEach`.
- [`config.test.js`](../shared/test/config.test.js) - `loadModelsConfig` / `getChatModel` / `getEmbeddingModel`
  resolution rules; per-stage override; cache reset; fallback to `default`.
- [`aem.test.js`](../shared/test/aem.test.js) - the `@aemdisc/shared` AEM client. Verifies request shape against
  a hand-rolled `createMockFetch` recorder: Sling POST encoding, CF model walk, `damPathToAssetsApi` path
  translation, the three typed errors (`AemAuthError`, `AemNotFoundError`, `AemUnavailableError`).
- [`smoke.test.js`](../shared/test/smoke.test.js) - single placeholder that imports the barrel and asserts the
  package is loadable. Guards against accidental export-graph breaks.

**`discovery-agent/test/`**

- [`parseBrief.test.js`](../discovery-agent/test/parseBrief.test.js) - deterministic shape (locale detection,
  brand vocab clamping), retry-with-error-hint on `LlmJsonParseError`, `LlmTimeoutError` surfacing.
- [`retrieve.test.js`](../discovery-agent/test/retrieve.test.js) - full pipeline retrieve against a real
  `sqlite-vec` DB built from a 4-fragment fixture (`FIXTURE_FRAGMENTS`). Uses a deterministic
  `vectorFromTopic` so the embedder is replaced by a pure function - **no LLM is contacted**.
- [`analyseGaps.test.js`](../discovery-agent/test/analyseGaps.test.js) - structural gaps (locale relax,
  brand-filter drop), the LLM judge stub, candidate pool union, orphan-id rejection.
- [`compose.test.js`](../discovery-agent/test/compose.test.js) - the `buildOrphanCheckedSchema` wrapper,
  schema retry once, `reuse`/`new` section discrimination, `schemaVersion` enforcement.
- [`cli.test.js`](../discovery-agent/test/cli.test.js) - flag parser (`--json`, `--locale`, `--top`,
  `--source`, `--corpus`, `--results-dir`), exit code mapping, `INIT_CWD` path re-anchoring,
  `slugify`/`buildArtifactFilename` round-trip. Drives `runPipeline` with injected mocks for chat + embed.
- [`render-markdown.test.js`](../discovery-agent/test/render-markdown.test.js) - the markdown renderer as a
  pure view: deterministic output given a fixed `AgentOutput`. No I/O.

**`content-seeder/test/`**

- [`seed.test.js`](../content-seeder/test/seed.test.js) - `parseArgs` defaults, deterministic `planFragments`
  (same seed → identical IDs and reserved-topic placement), `avgBodyWords` body-length sanity.
- [`embeddings.test.js`](../content-seeder/test/embeddings.test.js) - `buildEmbeddingsDb` writes a valid
  `sqlite-vec` table; vectors round-trip; idempotent re-build.
- [`aem-push.test.js`](../content-seeder/test/aem-push.test.js) - CF model validation (`validateCfModel`) and
  `pushFragments` Sling-POST payload shape, with a hand-rolled mock client.
- [`preflight.test.js`](../content-seeder/test/preflight.test.js) - `preflightModels` HTTP probes against LM
  Studio, with `global.fetch` mocked.

**`scripts/test/`**

- [`full-run.test.js`](../scripts/test/full-run.test.js) - `runBriefWithRetry` retry semantics,
  `corpusPrecheck` (counts + locales), `buildIndexReadme`, `instrumentStages` timing capture,
  `localeFromSlug` / `inferLocale` heuristics, `buildSeedSummary`.

### Mocking patterns (the three workhorses)

1. **`global.fetch` swap.** LLM, AEM, and preflight tests all replace `global.fetch` in `beforeEach` and
   restore it in `afterEach` - e.g. [`llm.test.js#L28-L39`](../shared/test/llm.test.js) and
   [`preflight.test.js#L7-L13`](../content-seeder/test/preflight.test.js). No HTTP ever leaves the process.
2. **Real `sqlite-vec` in `mkdtemp()`.** Retrieval tests build a throw-away DB on the temp filesystem
   ([`shared/test/retrieve.test.js#L1-L23`](../shared/test/retrieve.test.js),
   [`discovery-agent/test/retrieve.test.js#L1-L24`](../discovery-agent/test/retrieve.test.js)) instead of
   mocking the driver - the math is the system under test, so stubs would defeat the purpose.
3. **Deterministic vectors as fake embedders.** `vectorFromTopic` (a normalised `sin()`-based hash) replaces
   the embedding model entirely. Pipeline tests inject this via the `embed` parameter so the LLM stack is
   never touched.

`PROMPT_LOG_PATH` is redirected to a `mkdtemp` per test ([`parseBrief.test.js#L11-L19`](../discovery-agent/test/parseBrief.test.js))
so log appends do not pollute `runtime-prompt-log.md`.

### What is **not** tested (and why)

- **LM Studio itself** - out of scope; the harnesses call the real server in `npm run agent` / `npm run eval`.
- **`sqlite-vec` native extension correctness** - trusted as a dependency; we test our usage of it, not its
  cosine math.
- **Markdown rendering against external diff tooling** - `render-markdown.test.js` only asserts our string
  output is stable.
- **End-to-end against a real AEM tenant** - `AemFragmentSource` is exercised via mocked fetch; live AEM is
  reached only by the production path (`--source=aem`).

### Determinism budget

The whole suite runs in ~10.6s on a developer laptop (`duration_ms 10653` in the last green run). Tests that
need randomness use fixed seeds - `planFragments(seed=42)` in
[`seed.test.js#L9`](../content-seeder/test/seed.test.js), `DEMO_SEED = 20260626` in eval expectations.

**Pop quiz.** A new test for `retrieve()` needs an embedding vector but you cannot call LM Studio in CI.
Which two patterns from this section would you compose to get a deterministic, network-free fixture?

---

## 18. CLI, artifacts & operational concerns

Source: [`discovery-agent/src/cli.js`](../discovery-agent/src/cli.js).

Flags ([`cli.js#L15-L33`](../discovery-agent/src/cli.js)):

| Flag                  | Effect                                                                                 |
|-----------------------|----------------------------------------------------------------------------------------|
| `--json`              | Emit canonical `AgentOutput` JSON instead of Markdown                                  |
| `--locale=<code>`     | Override locale detected by `parseBrief`                                               |
| `--quiet`             | Set `LOG_LEVEL=silent`, suppress pino output                                           |
| `--top=<n>`           | Debug top-k override; 1..10, default 3                                                 |
| `--source=json|aem`   | Switch fragment source; default `json`                                                 |
| `--corpus=<path>`     | Override corpus path for `--source=json`; default `data/corpus.json`                   |
| `--results-dir=<path>`| Override artifact directory; default `runs/agent`                                      |

Exit codes ([`cli.js#L33`](../discovery-agent/src/cli.js)): `0` success, `1` pipeline/validation error, `2` input
error (missing brief, bad flag).

Every successful run also writes a **timestamped artifact** via `persistAgentArtifact`
([`persistResult.js#L32-L41`](../discovery-agent/src/persistResult.js); called at
[`cli.js#L170-L188`](../discovery-agent/src/cli.js)). The filename is
`<ISO-timestamp>-<brief-slug>.<md|json>` and is constructed by `buildArtifactFilename` /
`timestampForFilename` / `slugify` ([`persistResult.js#L8-L30`](../discovery-agent/src/persistResult.js)).

### Env vars worth remembering

(From `CLAUDE.md`'s **Key env vars** table.)

| Var                          | Default                                            | Used in                                                       |
|------------------------------|----------------------------------------------------|---------------------------------------------------------------|
| `CHAT_TIMEOUT_MS`            | `120000`                                           | [`chat.js#L10-L18`](../shared/src/llm/chat.js)                   |
| `LLM_HOST`                   | `http://localhost:1234`                            | [`llm.js#L23-L25`](../shared/src/llm/llm.js)                     |
| `EVAL_CHAT_MODEL`            | `config.chat.default`                              | [`eval/run.js#L27`](../eval/run.js)                              |
| `DISABLE_THINKING_MODE`      | unset                                              | qwen3 `think: false` path (alluded to in `chat.js` JSDoc)     |
| `LOG_LEVEL`                  | `info`                                             | [`llm.js#L19`](../shared/src/llm/llm.js), seeder, harnesses      |
| `PROMPT_LOG_PATH`            | `runtime-prompt-log.md`                       | [`prompt-log.js#L11-L13`](../shared/src/llm/prompt-log.js)       |
| `INIT_CWD`                   | set by `npm run`                                   | [`cli.js#L9, L56`](../discovery-agent/src/cli.js)                |

`INIT_CWD` is a subtle gotcha: when the user runs `npm run -w discovery-agent`, `process.cwd()` is the
sub-package, not the repo root. The CLI re-anchors paths to `INIT_CWD` (where the original `npm run` was invoked)
so `data/corpus.json` resolves correctly.

**Pop quiz.** Where does an `AgentOutput` JSON file land on disk after `npm run agent eval/briefs/foo.txt --json`?

---

## 19. Interview cheat-sheet - likely questions

These are the questions the design itself invites; canned answers below cite the supporting code.

> **Q. Walk me through what happens when I run `npm run agent eval/briefs/winter-sustainable.txt`.**

`cli.js` parses flags, loads the brief, builds a `JsonFragmentSource` for `data/corpus.json`, then calls
`runPipeline` ([`cli.js#L96-L115`](../discovery-agent/src/cli.js)). The pipeline calls:

1. `parseBrief` (1 chat call, JSON-validated against `StructuredBrief`).
2. `retrieve` (N embedding calls, one per topic; BM25 in-memory; locale ladder + brand filter; fused score
   `0.6·cos + 0.3·bm25 + 0.1·fresh`).
3. `analyseGaps` (1 chat call returning per-topic verdicts + deterministic structural gaps).
4. `compose` (1 chat call producing a `DraftOutline`; up to 1 retry; final `AgentOutput.parse`).

The Markdown renderer or JSON pretty-printer writes to stdout, and a timestamped copy lands in `runs/agent/`.

> **Q. Why hybrid retrieval and not pure vector?**

Pure cosine misses exact-keyword matches (SKU codes, brand-guideline tags). Pure BM25 misses paraphrase and is
multilingual-weak (the stopword list is English-only,
[`bm25.js#L3-L7`](../shared/src/retrieve/bm25.js)). The 60/30/10 weighting was chosen because the corpus is small and
multilingual: vectors dominate, BM25 anchors precision, freshness lightly biases recency. The literal weights live
at [`retrieve.js#L10`](../discovery-agent/src/pipeline/retrieve.js); the rationale is in
[`delivery.md`](../delivery.md) and [`why.md`](why.md).

> **Q. How do you prevent the LLM from hallucinating fragment ids?**

Two layers. `analyseGaps` post-processes `partialMatches[]` with `sanitiseVerdict`
([`analyseGaps.js#L143-L155`](../discovery-agent/src/pipeline/analyseGaps.js)) and strips any id not in the candidate
pool. `compose` uses `buildOrphanCheckedSchema`
([`compose.js#L46-L62`](../discovery-agent/src/pipeline/compose.js)) to add a Zod `superRefine` that rejects orphan
`fragmentIds` *before* the outline is accepted. Final `AgentOutput.parse` enforces it again.

> **Q. How is the system deterministic / reproducible?**

The seeder uses Mulberry32 ([`rng.js#L3-L12`](../content-seeder/src/rng.js)) plus a per-fragment Faker seed
([`generate.js#L125-L127`](../content-seeder/src/generate.js)), all derived from a single `--seed` integer. The eval
harness pins `DEMO_SEED = 20260626` ([`eval/run.js#L14`](../eval/run.js)). LLM determinism is a separate matter:
chat calls are local but not pinned to a seed by default; eval still works because the metrics are tolerant of
phrasing variance (gap-F1 uses 0.5-cosine pairing on topic strings, [`run.js#L23, L101`](../eval/run.js)).

> **Q. What's your error strategy?**

Seven typed error classes in [`errors.js#L25-L31`](../shared/src/llm/errors.js) let callers branch on
*shape-vs-availability*. `llmFetch` retries only network and 5xx ([`llm.js#L77-L116`](../shared/src/llm/llm.js)).
`JsonParseError` / `ZodError` retries happen at the **call site** with a stricter prompt:
`parseBrief.js#L68-L81`, `analyseGaps.js#L132-L140`, `compose.js#L64-L98`. The last LLM call (`compose`) fails
loud after the retry - there is no third attempt.

> **Q. Why Zod everywhere and not just at the boundary?**

Each stage hands the next a *typed* object, and each LLM call validates its own reply. That means:
- An LLM mistake fails the stage that made the call, not three stages later.
- The renderer is provably a view over `AgentOutput` - it cannot read fields the schema doesn't declare.
- The eval harness can short-circuit a failing `compose` and still score retrieval+gaps
  ([`run.js#L171-L184`](../eval/run.js)).

> **Q. Why local LLMs?**

Cost, privacy, and the brief's explicit preference for local execution. LM Studio's OpenAI-compat surface
(`/v1/chat/completions`, `/v1/embeddings`) means the same client works against most local stacks. See
[`delivery.md#L11-L24`](../delivery.md) on embedding choice and [`why.md`](why.md) for the lineage choice
between chat and embedding models.

> **Q. What would you change to scale to 40k fragments?**

Three concrete moves, all signposted in [`delivery.md`](../delivery.md):

1. Truncate Matryoshka embeddings from 768 → 256/128 to fit memory and speed lookup.
2. Move BM25 out of `retrieve` into an index built once at seed-time (it is currently rebuilt per request at
   [`retrieve.js#L90`](../discovery-agent/src/pipeline/retrieve.js)).
3. Replace the post-hoc `filterIds` cursor in `searchByVector` with a sqlite-vec `WHERE rowid IN (...)` push-down
   ([`vectorStore.js#L30-L45`](../shared/src/retrieve/vectorStore.js)).

> **Q. How would you add streaming/partial output?**

`chat.js` currently sets `stream: false` ([`chat.js#L57`](../shared/src/llm/chat.js)). Streaming the **final**
compose call is easiest because consumers want the outline incrementally. The intermediate stages return JSON, so
streaming them buys nothing.

---

## 20. Glossary

- **AgentOutput** - the single Zod-validated object returned by `compose`. Contract: `schemaVersion`, `brief`,
  `matchedFragments[≤3]`, `gaps[]`, `draftOutline`, `reusedFragments[]`. Source:
  [`shared/src/schema/output.js#L48-L55`](../shared/src/schema/output.js).
- **BM25** - the keyword-relevance scoring function provided by `wink-bm25-text-search`. Lives entirely in memory;
  built per request.
- **Brand guideline** - one of the four labels in `BRAND_VOCAB`
  ([`parseBrief.js#L12-L17`](../discovery-agent/src/pipeline/parseBrief.js)). Used by the brand filter in `retrieve`.
- **Brief** - the raw text input. After `parseBrief`, the structured form is called `StructuredBrief`.
- **Candidate pool** - the deduplicated set of fragments `analyseGaps` reasons over: `matches ∪ nearMisses ∪
  droppedByBrandFilter` ([`analyseGaps.js#L45-L60`](../discovery-agent/src/pipeline/analyseGaps.js)).
- **Coverage** - `"none" | "partial"`. Per-topic verdict emitted by `analyseGaps` and constrained by
  `GAP_COVERAGE` ([`output.js#L12`](../shared/src/schema/output.js)).
- **DEMO_SEED** - `20260626`, the locked seed against which eval expectations are valid
  ([`eval/run.js#L14`](../eval/run.js)).
- **Freshness** - `clamp01(1 − monthsSinceModified / 18)` ([`retrieve.js#L20-L26`](../discovery-agent/src/pipeline/retrieve.js)).
- **Locale ladder** - three-rung fallback (exact → prefix → any) applied before scoring
  ([`retrieve.js#L28-L35`](../discovery-agent/src/pipeline/retrieve.js)).
- **LM Studio** - local OpenAI-compatible LLM server at `http://localhost:1234`
  ([`llm.js#L11-L15`](../shared/src/llm/llm.js)).
- **Orphan fragmentId** - a `fragmentId` returned by `compose` that does not appear in `matchedFragments`. Caught
  by `buildOrphanCheckedSchema` ([`compose.js#L46-L62`](../discovery-agent/src/pipeline/compose.js)).
- **Reserved topics** - six fixed entries that guarantee the demo brief has retrievable matches per locale
  ([`topics.js#L3-L34`](../content-seeder/src/topics.js)).
- **Structural gap** - a gap synthesised from retrieval shape (locale relaxed, brand filter dropped fragments)
  rather than from the LLM judge ([`analyseGaps.js#L157-L204`](../discovery-agent/src/pipeline/analyseGaps.js)).

---

*End of guide. If you can answer every "Pop quiz" above without re-reading, you can hold the system in your head.*
