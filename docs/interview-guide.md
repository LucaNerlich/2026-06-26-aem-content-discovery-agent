# Interview Walkthrough - AEM Content Discovery Agent

Companion to the take-home submission. Cross-references the original brief
([`AEM_Content_Discovery_Agent_Brief.pdf`](../AEM_Content_Discovery_Agent_Brief.pdf)),
the architecture overview ([`docs/architecture.md`](architecture.md)), the
decision log ([`docs/why.md`](why.md)), and the evaluation harness output
([`eval/latest.json`](../eval/latest.json)).

## 1. Two-minute opening pitch

The agent is a Node 22 CLI that turns a free-form content brief into a strict,
Zod-validated `AgentOutput` with exactly three blocks: top-3 reusable
Content Fragments, a gap analysis, and a draft page outline. It runs in four
sequential stages - `parseBrief → retrieve → analyseGaps → compose` - all
backed by a **local** LLM stack (LM Studio: `google/gemma-4-e4b` for chat,
`text-embedding-embeddinggemma-300m` for embeddings) and a **local** content
corpus (`data/corpus.json` + a persisted `sqlite-vec` index).

Two architectural moves keep it reviewer-friendly and honest:

1. **JSON-primary, AEM-optional.** `data/corpus.json` and `data/embeddings.db`
   are committed; the agent runs on a clean clone with no AEM SDK install.
   A live AEM Assets path still ships behind `--source=aem` to demonstrate
   AEM depth ([`docs/why.md` § JSON-primary, AEM-optional](why.md)).
2. **Eval harness as the design contract.** `npm run eval` scores precision@3,
   recall@3, and a semantic gap-F1 across 8 hand-labelled briefs and exits
   non-zero below the 0.6 gap-F1 threshold. Latest aggregate: **gap-F1 ≈ 0.75**
   (above the floor) on the locked seed ([`eval/latest.json`](../eval/latest.json)).

### Where the RAG happens

RAG is the whole `parseBrief → retrieve → analyseGaps → compose` pipeline, not a
single step - that's why retrieval and generation are split across four typed
stages instead of a one-shot prompt.

- **`parseBrief()`** turns the free-form brief into a `StructuredBrief`
  (topics, audience, locale, brand-guidelines list). This is what makes
  retrieval queryable - topics become embedding inputs and filter predicates.
- **`retrieve()`** is the retrieval layer (`discovery-agent/src/pipeline/retrieve.js`).
  Per topic it first narrows the candidate pool via the locale ladder
  (exact → `en-*` → any), embeds the query with `embeddinggemma-300m`, runs a
  `sqlite-vec` cosine search, fuses with in-memory BM25 (`wink-bm25-text-search`)
  and a freshness signal at `0.6 · cosine + 0.3 · BM25 + 0.1 · freshness`, then
  applies an optional brand-guidelines filter. Output is a `RetrievalResult`
  with the top fragments plus locale/brand relaxation signals (`localeRelaxed`,
  `droppedByBrandFilter`) that `analyseGaps` synthesises into structural gaps;
  each match carries a deterministic, human-readable `reason` string.
- **`analyseGaps()`** is the first augmentation step: it receives the
  structured brief plus the retrieved fragments and asks a single batched
  LLM judge to label per-topic `coverage` (`none | partial`), then
  synthesises the structural gaps and applies post-LLM invariants
  (orphan-id drop, `partial`→`none` downgrade on empty matches).
- **`compose()`** is the second augmentation step (`discovery-agent/src/pipeline/compose.js`):
  it receives the brief, the retrieved fragments, and the merged gaps, and
  generates the `draftOutline` constrained to a per-call Zod schema whose
  `superRefine` rejects any reuse section citing a fragment id not in
  `matchedFragments`.

This is RAG rather than plain search because the retrieved fragments are
both **augmenting** downstream prompts and **constraining** generation:
the composer cannot invent ids, the gap analyser cannot claim coverage
without retrieved evidence, and every transformation is Zod-validated with
a bounded re-prompt on failure.

## 2. Mapping the PDF requirements to the repo

| PDF requirement | Where it lives | Notes |
|---|---|---|
| Synthetic content library, 15–20 JSON fragments, locked schema (`id`, `title`, `category`, `targetAudience`, `brandGuidelinesApplied`, `locale`, `lastModified`, `content`) | `data/corpus.json` (seeded by `content-seeder/`); schema in `shared/src/schema/fragment.js`; CF Model XML in `aemcontentdisc/ui.content/` | Seeded with 40/locale × 3 locales = 120 fragments (above the 15–20 floor) to give meaningful retrieval signal. Same shape on both sides of the JSON ↔ AEM boundary. |
| Runnable agent script - single command, prints all three outputs | `npm run agent -- eval/briefs/winter-sustainable.txt` (Markdown) and `… --json` (canonical `AgentOutput`); entry point `discovery-agent/src/cli.js` | No AEM dependency on the default path. |
| Architecture doc - one page, justifies (a) embedding model, (b) chunking, (c) retrieval method, (d) why agentic | [`docs/architecture.md`](architecture.md); rationale recorded per-decision in [`docs/why.md`](why.md) | All four required questions answered with citations to source files. |
| Prompt logs | [`docs/runtime-prompt-log.md`](runtime-prompt-log.md) (auto-appended on every chat call) + curated templates in [`docs/prompt-templates.md`](prompt-templates.md) | Every call - success or failure - is logged with `{ ts, model, ok, durationMs, system, user, response }` on success or `{ ts, model, ok, durationMs, system, user, errorClass, errorMessageHead }` on failure; `system`/`user`/`response`/`errorMessageHead` are truncated to 200 chars. |
| Sample run for the example brief in the README | [`docs/sample-run.md`](sample-run.md) - captured JSON + Markdown render | The brief is reproduced verbatim from the PDF (winter-sustainable). |
| Three output blocks: top matches, gaps, outline | `shared/src/schema/output.js` - `AgentOutput` (`schemaVersion: "1.0"`, `matchedFragments[0..3]`, `gaps[]`, `draftOutline.sections[1..8]`) | Markdown renderer is a pure view over the same object - no parallel implementation. |
| Submission: code + prompt logs + corpus JSON + README + arch doc | Repo root holds all of them; corpus is committed | A grader can clone and run without re-seeding. |

## 3. Core technical decisions (with the "why" in one line each)

The full reasoning per decision lives in [`docs/why.md`](why.md). Headline calls:

- **JSON-primary, AEM-optional** - `data/corpus.json` is canonical; AEM is two
  opt-in flags (`seed --aem-push`, `agent --source=aem`). Keeps the agent
  runnable on a clean clone while still demonstrating AEM competence.
- **npm workspaces (`shared` / `content-seeder` / `discovery-agent`)** - same
  Zod schemas and LLM/AEM clients shared across packages; different lifecycles
  isolated (seeder pulls faker; agent does not).
- **LM Studio @ `:1234`, OpenAI-compatible HTTP** - local, zero-cost, no rate
  limits. Single source of model truth in `config/models.json` (`chat.default`
  + optional per-stage overrides + `embedding.default`).
- **Chat = `google/gemma-4-e4b`** - multilingual, JSON-mode capable, fast
  enough for the full-run harness on consumer hardware. `gemma4:26b` and
  `qwen3.5:9b` are documented premium alternatives - flip one file, no rebuild.
- **Embeddings = `text-embedding-embeddinggemma-300m` (768-d)** - same Gemma
  research lineage as the chat model, 100+ languages (genuine multilingual
  signal for `fr-fr` / `de-de`), Matryoshka-truncatable to 512/256/128 for a
  credible scale-up story at hypothetical 40k-doc corpus sizes.
- **Chunking = fragment-as-chunk** - a Content Fragment is already the
  reusable authoring unit (~150–250 words); sub-fragment chunking would split
  reuse-able material below what the composer can cite by id.
- **Hybrid retrieval = `0.6 · cosine + 0.3 · BM25 + 0.1 · freshness`** -
  semantic dominates because the corpus is paraphrased marketing copy; BM25
  is the proper-noun backstop (brand names, "merino"); freshness is a
  tiebreaker only. Vector store is `sqlite-vec` (persistent, SQL-queryable);
  BM25 is `wink-bm25-text-search` in-memory.
- **Locale ladder = exact → language prefix (`en-*`) → any** - every fallback
  surfaces as a structural gap on the output (`localeRelaxed` flag) so the
  user sees that relaxation happened.
- **Gap analysis = single batched LLM judge + deterministic
  `suggestedAction` + post-LLM invariants** - one chat call per run; orphan
  ids in `partialMatches` are dropped; `partial` with empty matches is
  downgraded to `none`; structural locale/brand gaps are synthesised
  independently of the LLM so they always appear when retrieval demands them.
- **Schema validation = Zod everywhere, fail-loud with bounded retry** - every
  stage validates its output; `JsonParseError`/`ZodError` triggers a re-prompt
  with the error appended to the system prompt, then propagates. `parseBrief`
  retries up to twice (one extra retry with a stricter "JSON only" reminder);
  `analyseGaps` and `compose` retry exactly once.
  Composer enforces orphan-id rejection via `superRefine` so reuse sections
  can only cite ids present in `matchedFragments`.
- **Prompt logging = every call, success or failure** - `docs/runtime-prompt-log.md`
  is greppable, 200-char head truncation; curated templates in
  `docs/prompt-templates.md` capture the verbatim system/user prompts per stage.
- **Eval harness = offline F1 + non-zero exit on regression** - 8 briefs in
  `eval/briefs/`, gold labels in `eval/expectations/`, scores written to
  `eval/latest.json`. Exits non-zero below `EVAL_F1_THRESHOLD` (default 0.6).
- **Seeder is the sole writer to `data/embeddings.db`; agent opens read-only.**
  No runtime embedding cache - predictable startup, no dim-mismatch races.

## 4. Demo script (≈8 minutes)

```bash
# 0. Pre-warm LM Studio: load gemma-4-e4b + embeddinggemma-300m, start server.
nvm use && npm install

# 1. (Optional, skippable - corpus is committed) Re-seed deterministically.
npm run seed -- --seed=20260626 --count=40   # writes data/corpus.json (120 fragments)
npm run embed                                # writes data/embeddings.db (768-d vectors)

# 2. Run the PDF's example brief - Markdown for humans.
npm run agent -- eval/briefs/winter-sustainable.txt

# 3. Same brief, canonical JSON - show schema, matchedFragments[3], gaps, outline.
npm run agent -- eval/briefs/winter-sustainable.txt --json | jq .

# 4. Different locale - fr-fr knitwear, demonstrates locale ladder.
npm run agent -- eval/briefs/fr-fr-knitwear.txt --json | jq '.gaps[].topic'

# 5. The contract: full evaluation harness.
npm run eval        # → eval/latest.json, exits non-zero below gap-F1 0.6

# 6. (Optional, if AEM is up) Live AEM source mode.
npm run agent -- eval/briefs/winter-sustainable.txt --source=aem
```

Talking points to hit as it runs:

- Show `docs/runtime-prompt-log.md` updating in real time - every chat call is logged.
- `eval/latest.json` headline numbers from the most recent run:
  precision@3 ≈ **0.42**, recall@3 ≈ **0.42**, gap-F1 ≈ **0.75** (above the
  0.6 floor). Per-brief breakdown is honest - `de-de-workwear-tech` and
  `fr-fr-loungewear-premium` currently score 0 on precision/recall while
  still landing gap-F1 of 0.8 (`de-de-workwear-tech`) and a perfect 1.0
  (`fr-fr-loungewear-premium`), which is the trade-off the next round of
  corpus tuning would attack.
- Open `docs/architecture.md` - point to the four required-by-PDF justifications.
- Open `docs/why.md` - show that every non-trivial choice has a dated entry with
  alternatives considered and consequences.

## 5. Likely panel questions - concise answer bullets

**Why not LangChain / LlamaIndex?**
- Pipeline is four stages; hand-rolling gives full control over retries,
  logging, and the typed error model. Frameworks would hide the seams the
  brief explicitly grades on.

**Why `sqlite-vec` and not Qdrant / pgvector / FAISS?**
- Zero-server constraint, SQL-queryable for debugging, right-sized for the
  120-fragment corpus, and a credible path to ~10k via the same primitives.
  Documented in [`docs/why.md` § sqlite-vec for persistent vector storage](why.md).

**Why the `0.6 / 0.3 / 0.1` weights - were they tuned?**
- Hand-picked from a defensible story (semantic dominates paraphrase, BM25
  catches proper nouns, freshness is a tiebreaker). Not learned from the
  eval set on purpose - that would overfit 8 briefs and make the metric
  meaningless. Re-tunable if the corpus character changes substantially.

**How do you guarantee the LLM doesn't hallucinate fragment ids?**
- The composer's Zod schema is built per call from `matchedFragments` ids
  and uses `superRefine` to reject any reuse section whose `fragmentIds`
  contain an unknown id. On failure, one re-prompt with the error appended;
  if still bad, the typed error propagates with a clear JSON path.

**What if the model returns malformed JSON?**
- Uniform retry pattern: catch `LlmJsonParseError` / `ZodError` exactly
  once, append the error message to the system prompt, retry. Transient 5xx
  / connection failures are retried inside `llmFetch` with backoff.
  Everything else propagates as a typed error.

**Multilingual - really, or just `en-gb` with locale tags?**
- Genuinely multilingual: `embeddinggemma` covers 100+ languages, the seeder
  generates fr-fr and de-de bodies natively, and the eval harness includes
  `fr-fr-knitwear`, `fr-fr-loungewear-premium`, `de-de-berlin-street`, and
  `de-de-workwear-tech` briefs that exercise the locale ladder end-to-end.

**Why local LLM instead of OpenAI / Anthropic?**
- Brief explicitly favours local models; zero-cost reproduction for the
  reviewer; no rate limits during seeding (which generates ~120 bodies);
  privacy story for enterprise clients who own their corpora.

**What happens when `--source=aem` is used instead of JSON?**
- Vector stage is skipped (no embeddings on the live AEM payload - the
  seeder is the sole writer to `embeddings.db`). Retrieval falls back to
  BM25 + freshness only; the composer/gap analyser still receive a
  normalised `RetrievalResult` so output shape is unchanged.

**How long did this take?**
- ~12 h, ~4 h over the 8 h target. The over-budget time went into the AEM
  round-trip + multi-locale corpus + eval harness - all three are signal
  for the interview rather than nice-to-haves.

## 6. Honest limitations and follow-up improvements

- **Aggregate precision/recall @ 3 sit around 0.42.** Two of the eight briefs
  currently score 0 on retrieval precision/recall even though gap-F1 stays
  high. Tractable next step: tune the seeder's topic distribution so
  `de-de-workwear-tech` and `fr-fr-loungewear-premium` have at least one
  obviously-relevant fragment per required topic; the eval threshold is
  intentionally on gap-F1 (the harder semantic metric), not on raw recall.
- **Gap-F1 reflects an LLM judge.** The harness greedy-matches expected and
  returned gap labels by cosine ≥ 0.5 plus `coverage` enum agreement.
  Different chat models drift on `partial` vs `none` - documented in
  [`eval/README.md` § Model variance](../eval/README.md).
- **No learned retrieval weights.** Weights are constants; on a substantially
  different corpus character (long-form technical docs) they would need
  re-tuning. Would explore RRF + small held-out tuning set at scale.
- **`sqlite-vec` does a full-table scan via `vec_distance_cosine()` rather
  than the vec0 `MATCH` ANN index.** Fine at ≤10k fragments, would need
  revisiting at the hypothetical 40k+ scale.
- **No incremental seeding.** Each `npm run seed` drops and recreates
  `data/embeddings.db`. Acceptable while the corpus is 120 rows; the cache
  key `(id, lastModified, model)` is sketched in `docs/why.md` and can be added
  when the requirement appears.
- **Markdown renderer is a single view.** A second view (HTML, JSON-LD,
  AEM CF authoring payload) would be straightforward - the `AgentOutput`
  contract is the integration boundary.
- **No browser/UI surface.** Per the brief, the deliverable is a CLI. An
  ExC Shell extension or AEM UI extension is the obvious next step for a
  product version.

## 7. Quick file index

| File | What it is |
|---|---|
| [`AEM_Content_Discovery_Agent_Brief.pdf`](../AEM_Content_Discovery_Agent_Brief.pdf) | Original take-home brief from Adobe. |
| [`README.md`](../README.md) | Setup, quickstart, run commands. |
| [`docs/architecture.md`](architecture.md) | Pipeline + schema reference. |
| [`docs/sample-run.md`](sample-run.md) | Real `--json` capture of the PDF's example brief + Markdown render. |
| [`docs/prompt-templates.md`](prompt-templates.md) | Verbatim system/user templates and tuning notes per stage. |
| [`docs/runtime-prompt-log.md`](runtime-prompt-log.md) | Auto-appended runtime chat transcript (every call). |
| [`docs/why.md`](why.md) | Append-only decision log. |
| [`eval/README.md`](../eval/README.md) | Eval harness design + metric definitions. |
| [`eval/latest.json`](../eval/latest.json) | Most recent run's metrics, per-brief. |
| [`config/models.json`](../config/models.json) | Single source of truth for chat + embedding model selection. |
