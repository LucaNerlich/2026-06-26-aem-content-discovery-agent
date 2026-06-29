# Delivery: Decision Rationale

> An AI-powered discovery layer for AEM Content Fragments: give it a campaign brief and it returns ranked fragments, identified gaps, and a ready-to-use outline.
> Built to run entirely on local models, it keeps sensitive content and editorial strategy inside your infrastructure.

This document justifies the significant design choices behind the AEM Content
Discovery Agent. It does not describe what was built - for that, see
[`README.md`](../README.md) and [`architecture.md`](architecture.md).

## 1. Embedding model - `text-embedding-embeddinggemma-300m` (768-d)

**Choice.** Local embeddings served by LM Studio at `:1234`, configured in
[`config/models.json`](../config/models.json).

**Why for this content / use case.** The corpus is multilingual by
construction (en-gb, fr-fr, de-de Content Fragments). `embeddinggemma-300m`
covers 100+ languages, so fr-fr and de-de bodies produce genuine semantic
signal rather than English-only embeddings with locale tags bolted on. It
shares the Gemma research lineage with the chat model
(`google/gemma-4-e4b`), giving a single-stack narrative. Its Matryoshka
representation is truncatable from 768 → 512 / 256 / 128, providing a
credible scale-up story at the hypothetical 40k-doc corpus size without
re-embedding. Local execution matches the brief's preference for local,
zero-cost models.

**Rejected alternatives.** `nomic-embed-text` - English-mostly, weak for
fr-fr/de-de. Hosted OpenAI embeddings - cost, rate limits, and the brief
favours local. Reusing the chat model as an embedder - chat models are not
embedders.

**Details:** see [Embedding model](architecture.md#embedding-model) in the architecture doc.

## 2. Chunking strategy - fragment-as-chunk

**Choice.** One chunk per AEM Content Fragment; no sub-fragment splitting.

**Why for this content / use case.** A Content Fragment is already the
atomic reusable authoring unit (~150–250 words). The composer's contract is
that any reuse section cites a *whole* fragment id present in
`matchedFragments`, enforced by a Zod `superRefine` on the per-call output
schema. Sub-fragment chunking would split reusable material below the unit
the output actually references, surfacing partial fragments the author
could not act on without manual reassembly.

**Rejected alternatives.** Fixed-size / sliding-window token chunks and
sentence-or-paragraph splitting - both produce chunks that are not
addressable by fragment id and therefore cannot be re-assembled into a
"reuse this whole fragment" suggestion.

**Details:** see [Chunking strategy](architecture.md#chunking-strategy) in the architecture doc.

## 3. Retrieval method - hybrid fused score `0.6 · cosine + 0.3 · BM25 + 0.1 · freshness`

**Choice.** Hybrid retrieval: `sqlite-vec` cosine search plus
`wink-bm25-text-search` BM25 plus a freshness signal, blended at fixed
weights, wrapped by a locale ladder (exact → `en-*` → any).

**Why for this content / use case.** The seeded corpus is LLM-paraphrased
marketing copy, so semantic similarity must dominate to catch paraphrase.
BM25 is the proper-noun backstop - brand names and material terms like
"merino" need exact lexical match that a 300M-parameter embedder cannot
guarantee. Freshness is a tiebreaker only and intentionally small. The
locale ladder relaxes only when it must, and every relaxation surfaces as
a structural gap so the user sees that it happened.

**Rejected alternatives.** Pure vector - misses exact brand matches. Pure
BM25 - misses paraphrase. Reciprocal Rank Fusion - adds a `k` constant to
tune for no measurable benefit at this corpus size. Learned weights - would
overfit an 8-brief eval set.

**Trade-off.** Weights are constants. A substantially different corpus
character (e.g. long-form technical docs) would warrant re-tuning.

**Details:** see [Score components explained](architecture.md#score-components-explained) in the architecture doc for the per-component breakdown and weight rationale.

## 4. Why agentic + the orchestration pattern - sequential typed multi-stage pipeline

**Choice.** RAG split across four typed stages - `parseBrief → retrieve →
analyseGaps → compose` - orchestrated as a deterministic sequential
pipeline with typed errors and a bounded one-shot re-prompt on schema
failure.

**Why agentic.** The retrieved fragments do two jobs at once: they
*augment* downstream prompts (both the gap judge and the composer receive
them) and they *constrain* generation. The composer's Zod `superRefine`
rejects any reuse section citing a fragment id outside `matchedFragments`,
and the gap judge cannot claim coverage without retrieved evidence. Each
stage validates its own output, so a malformed `DraftOutline` triggers a
targeted re-prompt for that stage only - a single mega-prompt cannot
offer per-stage validation, per-stage retry budget, or per-stage model
selection.

**Why this orchestration pattern.** Hand-rolled sequential pipeline, not
an autonomous tool-loop / ReAct agent and not a framework (LangChain,
LlamaIndex). The seams the rest of the design depends on - per-stage Zod
schemas, per-stage model selection in `config/models.json`, per-stage
prompt logging in `docs/runtime-prompt-log.md` - must stay visible and
individually testable.

**Rejected alternatives.** One-shot prompt that returns matches + gaps +
outline together - loses per-stage validation and selective retry; one
bad section blocks all output. Autonomous tool-loop agent -
non-deterministic call patterns, harder to audit against the locked
`AgentOutput` schema. RAG framework - extra abstraction layers obscure
the seams the contract depends on.

**Details:** see [Why agentic](architecture.md#why-agentic) in the architecture doc.

## Other notable decisions

- **JSON-primary, AEM-optional.** `data/corpus.json` and
  `data/embeddings.db` are committed so a clean clone runs without an
  AEM SDK; `--source=aem` is an opt-in flag for the live AEM round-trip. (Details: see [Monorepo layout](architecture.md#monorepo-layout))
- **Local LM Studio at `:1234`.** OpenAI-compatible HTTP, zero-cost
  reproduction, no rate limits; single source of model truth in
  `config/models.json`. (Details: see [LLM stack](architecture.md#llm-stack))
- **Schema-validated, fail-loud-with-retry.** Every stage validates its
  output with Zod; `JsonParseError` / `ZodError` triggers one re-prompt
  with the error appended, then propagates as a typed error.
- **Eval harness as contract.** `npm run eval` scores precision@3 /
  recall@3 / gap-F1 across 8 hand-labelled briefs and exits non-zero
  below the 0.6 gap-F1 threshold. (Details: see [Evaluation harness](architecture.md#evaluation-harness))
