# PRD - AEM Content Discovery Agent

## Problem Statement

Content authors at a large retail brand spend several hours per landing page performing work the CMS should handle automatically: manually searching 40,000+ AEM content pieces for reusable fragments, checking whether those fragments comply with the active brand guidelines, detecting which required topics are not yet covered by any existing content, and hand-assembling a page outline that correctly cites reusable parts versus net-new sections. By the time an author opens their editor, they should already know exactly what to reuse, what gaps exist, and roughly how the page should be structured.

---

## Solution

A command-line agent that accepts a plain-text content brief and produces three outputs in a single run:

1. **Top 3 matching content fragments** - ranked by relevance with a score and one-line match reason per fragment.
2. **Gap analysis** - topics the brief requires that no existing fragment adequately covers, each with a coverage verdict and a concrete suggested action.
3. **Draft page outline** - a structured outline that cites reusable fragment IDs for existing sections and clearly marks what must be written from scratch.

The agent is orchestrated as a linear four-stage LLM pipeline (`parseBrief → retrieve → analyseGaps → compose`) backed by a hybrid retrieval stack (semantic vector search + BM25 keyword search + freshness scoring) and a 120-fragment synthetic corpus seeded deterministically for reproducible evaluation.

---

## User Stories

### Brief Ingestion

1. As a content author, I want to pass my brief as a plain-text file to a single CLI command, so that I do not need to learn a new UI or fill out a form.
2. As a content author, I want the agent to accept a brief via stdin as well as a file path, so that I can pipe briefs from other tools.
3. As a content author, I want the agent to detect my target locale from the brief text automatically, so that I do not have to specify it separately unless there is ambiguity.
4. As a content author, I want the agent to extract required topics, tone, target audience, and brand guidelines from my free-form brief, so that I can write briefs naturally without adhering to a fixed template.
5. As a content author, I want the agent to surface any assumptions it made while parsing my brief (e.g., locale defaulted), so that I can spot and correct misreadings.
6. As a content author, I want to override the detected locale from the command line, so that I can force a specific market without editing my brief.

### Fragment Retrieval

7. As a content author, I want to see the top 3 most relevant fragments for my brief, ranked by relevance, so that I can immediately identify reuse candidates.
8. As a content author, I want each matched fragment to include a one-line explanation of why it matched, so that I can quickly judge whether the match is genuinely useful.
9. As a content author, I want fragments to be scored by semantic similarity, keyword overlap, and content freshness together, so that the ranking reflects editorial utility rather than a single signal.
10. As a content author, I want the agent to retrieve candidates per required topic and then fuse them into a single ranked list, so that no topic is systematically under-represented in the results.
11. As a content author, I want the agent to respect my brand guidelines when retrieving fragments, filtering out fragments that do not carry the required brand markers, so that the draft outline does not accidentally cite off-brand content.
12. As a content author, I want the agent to tell me when it relaxed the locale filter (e.g., from `en-gb` exact to `en-*` prefix) because no exact-locale fragments existed, so that I understand the fallback and can commission locale-specific content if needed.
13. As a content author, I want the agent to fall back gracefully to keyword-only retrieval when vector embeddings are unavailable, so that I still get useful results without a running embedding model.

### Gap Analysis

14. As a content author, I want to see a list of topics from my brief that are not covered by any existing fragment, so that I know exactly what net-new content I need to commission.
15. As a content author, I want partial coverage to be distinguished from zero coverage, so that I can decide whether to adapt an existing fragment or write from scratch.
16. As a content author, I want each gap to include a suggested commissioning action (category, locale, brand guidelines), so that I can hand the gap directly to a content producer without further specification.
17. As a content author, I want the gap analysis to include locale gaps when the agent had to relax locale filtering, so that missing per-market content is surfaced explicitly rather than silently papered over.
18. As a content author, I want the gap analysis to include brand-guideline gaps when required guidelines are absent from the top matches, so that brand compliance risks are visible before the page is assembled.
19. As a content author, I want partial gaps to list the fragment IDs that partially address the topic, so that I can review those fragments before deciding whether to adapt them.

### Draft Outline

20. As a content author, I want a structured draft outline for my page, so that I can start editing with a clear scaffold rather than a blank page.
21. As a content author, I want each outline section to be clearly typed as either REUSE or NEW, so that I know at a glance what is ready to use and what needs writing.
22. As a content author, I want REUSE sections to cite the specific fragment IDs they draw from, so that I can navigate directly to those fragments in AEM.
23. As a content author, I want NEW sections to include sourcing hints derived from the gap analysis, so that the outline doubles as a content commission ticket.
24. As a content author, I want the draft outline to include a suggested page title and URL path hint, so that the page can be created in AEM without a separate naming step.
25. As a content author, I want the path hint from my brief to take precedence over any LLM-generated path suggestion, so that the URL structure stays under my control.
26. As a content author, I want the full content of every reused fragment appended to the output, so that I can read and judge fragment suitability without switching to AEM.

### Output & Integration

27. As a content author, I want clean Markdown output by default, so that I can read the result in any terminal or editor immediately.
28. As a content author, I want a `--json` flag that returns a canonical `AgentOutput` JSON object, so that downstream tools or CMS integrations can parse the result programmatically.
29. As a content author, I want the output JSON to be versioned with a `schemaVersion` field, so that consumers can handle schema changes safely.
30. As a content author, I want each run's output persisted to a timestamped directory, so that I have a history of agent runs for the same brief over time.

### Corpus & Data

31. As a content operations engineer, I want the fragment corpus to include realistic retail marketing copy across product stories, care guides, and seasonal campaigns, so that retrieval quality reflects real-world content variety.
32. As a content operations engineer, I want the corpus to cover multiple locales (en-gb, fr-fr, de-de), so that the agent can serve multi-market briefs.
33. As a content operations engineer, I want the corpus and embeddings to be generated deterministically from a seed, so that evaluation results are reproducible.
34. As a content operations engineer, I want to regenerate the corpus and embeddings by running a single command, so that I can update the index without modifying code.
35. As a content operations engineer, I want to point the agent at a live AEM Assets HTTP API instead of the local JSON corpus, so that the agent can search real production content without a separate import step.

### Evaluation & Quality

36. As an AI engineer, I want an offline evaluation harness that scores the agent against hand-labelled briefs, so that I can measure retrieval precision and gap analysis quality before shipping changes.
37. As an AI engineer, I want precision@3 and recall@3 metrics for fragment matching, so that I can track whether the top-3 results satisfy the brief's requirements.
38. As an AI engineer, I want a gap-F1 metric that measures gap analysis accuracy, so that I can quantify how well the agent identifies missing content.
39. As an AI engineer, I want the evaluation harness to fail with a non-zero exit code when aggregate gap-F1 drops below a threshold, so that CI can gate on quality regressions.
40. As an AI engineer, I want to run the agent against all 20 evaluation briefs in batch, so that I can collect a full-run history for regression analysis.

### Configuration & Operations

41. As an AI engineer, I want model selection to live in a single `config/models.json` file with no rebuild step, so that I can swap models for any pipeline stage without touching code.
42. As an AI engineer, I want each LLM call (successful or failed) appended to a runtime prompt log, so that I can audit what the agent sent and received for any run.
43. As an AI engineer, I want per-call LLM timeouts configurable via an environment variable, so that I can tune timeouts without code changes.
44. As an AI engineer, I want the LLM client to retry automatically on transient server errors but surface parse and validation errors immediately, so that the retry logic is tight and caller-controlled retry (re-prompt with error context) handles semantic failures.
45. As an AI engineer, I want the agent to validate every stage's output with a Zod schema before passing it to the next stage, so that schema violations are caught at the source rather than surfacing as silent corruption downstream.

---

## Implementation Decisions

### Monorepo with three npm workspaces

The repository is split into `shared/`, `content-seeder/`, and `discovery-agent/`. Shared schemas, LLM client, and retrieval primitives are published internally as `@aemdisc/shared`. The seeder and agent have different dependency graphs (seeder pulls faker; agent does not) and different run lifecycles (seeder runs once; agent runs many times), making workspace isolation cleaner than a flat layout.

### Four-stage linear pipeline

The agentic approach uses a sequential pipeline rather than a loop or planner, because each stage's output is a necessary precondition for the next and the stages are not interchangeable. The orchestration pattern is deterministic stage composition: `parseBrief → retrieve → analyseGaps → compose`. Each stage is a pure-ish function, independently injectable via dynamic imports, and validated by Zod at its output boundary. A planner or tool-call loop would introduce non-determinism without improving the user-facing output for this fixed three-deliverable task.

### Hybrid retrieval: 0.6 cosine + 0.3 BM25 + 0.1 freshness

Semantic similarity (via 768-d embeddings from a local model) dominates because the corpus is LLM-paraphrased marketing copy where exact phrasing varies widely between fragments and briefs. BM25 provides a lexical backstop for proper nouns and brand-specific terms (material names, collection names) that embeddings can treat as interchangeable. Freshness is a tiebreaker only. Per-topic retrieval (top 15 from each retrieval method per `requiredTopic`) followed by score fusion ensures all brief topics are represented in the candidate pool before brand filtering and final ranking.

### sqlite-vec for persistent vector storage; seeder is sole writer

The vector database is a sqlite3 file opened read-only by the agent. The seeder is the only process that writes to it, making seeding an atomic all-or-nothing operation. This eliminates the possibility of a partially-written index being visible to the agent. The sqlite-vec extension supports 768-d Matryoshka-compatible embeddings, which can be truncated to smaller dimensions if latency becomes a constraint.

### Locale ladder: exact → language prefix → any

The agent filters fragments by locale before retrieval. If fewer than one result passes the exact-locale filter it relaxes to a language prefix (e.g., `en-*` matches both `en-gb` and `en-us`), then to any locale. Each relaxation sets a `localeRelaxed` flag that is visible in the output and triggers a structural gap in the gap analysis. This makes locale coverage failures explicit rather than silent.

### Brief parser: URL regex → LLM → default (locale detection precedence)

Locale detection uses a three-tier precedence: a regex match on path-like strings (`/en-gb/`, `/fr-fr/`) wins absolutely (paths are authoritative); LLM inference from audience description wins if no path is present; finally the parser falls back to `en-gb`. The brief's `pathHint` is extracted the same way and unconditionally overrides any LLM-generated path suggestion in the compose stage.

### Zod schema validation at every stage boundary

Each pipeline stage validates its output with a Zod schema before returning. On `ZodError` or `LlmJsonParseError`, stages re-prompt once with the error context appended to the system prompt. The compose stage additionally uses a Zod `superRefine` to enforce an orphan-id invariant: any `fragmentId` cited in a REUSE section must exist in the `matchedFragments` array. This single schema is the source of truth for that invariant.

### Seven typed LLM error classes with selective automatic retry

The LLM client defines `LlmUnavailableError`, `LlmServerError`, `LlmTimeoutError`, `LlmModelNotFoundError`, `LlmJsonParseError`, `LlmContextOverflowError`, and `LlmInvariantError`. Only `Unavailable` and `Server` are retried automatically inside `llmFetch` (transient infrastructure failures). All other error types surface immediately to the calling pipeline stage, which is responsible for re-prompting with error context when appropriate. This keeps retry semantics tight and observable.

### Gap `suggestedAction` is deterministic, not LLM-generated

The suggested commissioning action for each gap is derived purely from topic keywords mapped to seeder category constants, plus the brief's locale and brand guidelines. This makes `suggestedAction` deterministic and fully unit-testable without a running LLM, and prevents the gap output from hallucinating invalid actions.

### Two fragment sources behind a shared interface

`JsonFragmentSource` (default) reads the committed `data/corpus.json`. `AemFragmentSource` reads live from the AEM Assets HTTP API. Both implement the same `FragmentSource` interface so the retrieval stage is source-agnostic. When using AEM source mode, vector search is skipped (no live embedding of AEM content); BM25 + freshness carry the retrieval.

### 120-fragment corpus across three locales (vs 15–20 required by brief)

The brief required 15–20 fragments. The implementation seeds 120 (40 per locale across en-gb, fr-fr, de-de) to give the evaluation harness enough per-topic, per-locale coverage to distinguish retrieval failures from corpus gaps. The seed is deterministic (`--seed=20260626`) so evaluation labels are stable. The seeder uses topic reservations (six locked seasonal-clothing topics per locale) to guarantee the evaluation briefs always have ground-truth candidates.

### Config-driven model selection via `config/models.json`

Model IDs for each pipeline stage (parseBrief, analyseGaps, compose, seeder, eval) and the embedding model live in a single JSON file. The loader resolves stage-specific overrides with a fallback to `chat.default`. No rebuild is required to swap models. An `EVAL_CHAT_MODEL` environment variable overrides only the evaluation harness, leaving the agent runtime unchanged.

### Runtime prompt log

Every LLM call (success or failure) is appended to `docs/runtime-prompt-log.md` with timestamp, model, stage, outcome, elapsed time, and 200-character truncations of the prompt and response. This is a local-only audit trail; no redaction is applied because the tool is not deployed to a shared service.

### No lint or format tooling

The project uses `node --check` for syntax validation only. There is no ESLint or Prettier configuration. This was a deliberate decision to minimize setup friction for an 8-hour exercise scope.

---

## Testing Decisions

### What makes a good test

Tests should assert observable outputs given controlled inputs, not implementation details. For pipeline stages, a good test provides a deterministic `StructuredBrief` or `RetrievalResult` fixture and asserts on the shape and key values of the returned Zod-validated output. Tests must not assert on specific LLM response text (non-deterministic) - they assert on schema validity, score ranges, gap coverage verdicts, and presence/absence of specific fragment IDs.

### Primary test seam

The highest useful seam is the `AgentOutput` produced by the full pipeline from a `brief.txt` input. The eval harness (`eval/run.js`) exercises this seam against 20 hand-labelled briefs and produces `precision@3`, `recall@3`, and `gap-F1` metrics. Unit tests cover each pipeline stage function in isolation with fixtures, using the same DI pattern the CLI uses (dynamic imports allow stage mocks).

### Modules with unit tests

- **`shared/`** - Zod schemas (valid and invalid inputs), LLM error classes (retry behavior, error classification), BM25 tokenizer and scorer, vector store query helpers, locale ladder logic, hybrid score fusion.
- **`content-seeder/`** - Deterministic RNG and shuffle, topic distribution, fragment generation shape (schema validity), embedding batch size handling.
- **`discovery-agent/`** - Each pipeline stage (parseBrief, retrieve, analyseGaps, compose) with LLM calls mocked via dependency injection, CLI argument parsing, Markdown renderer output structure, orphan-id Zod invariant.

### Integration / eval tests

The eval harness is the integration test. It runs the full pipeline (with a real local LLM) across all 20 briefs and fails non-zero if `gap-F1 < 0.6`. The full-run script (`npm run full-run`) persists timestamped JSON + Markdown artifacts to `runs/full-run/` for regression diffing.

### Prior art in the codebase

Unit tests for the schema layer (`shared/test/`) and the retrieval primitives serve as the model for all other unit tests: fixture input → call function → assert on Zod-parsed output shape and selected field values. The eval harness's topic-aware matching logic (`topicKeyOf`) is the prior art for tests that need to handle near-duplicate fragment IDs.

---

## Out of Scope

- **Web UI** - the brief explicitly excludes a UI; the agent is CLI-only.
- **Multi-turn conversation** - the agent runs one brief per invocation; session state and follow-up questions are not modelled.
- **AEM write-back** - the agent reads from AEM (via `--source=aem`) but never writes to it; page creation and content import are out of scope.
- **Authentication and secrets management** - the AEM client uses Basic auth passed as environment variables; a production secrets manager is not in scope.
- **Production deployment** - the agent runs locally against LM Studio; packaging for cloud deployment (Docker, serverless) is out of scope.
- **Languages beyond en-gb, fr-fr, de-de** - the corpus and locale ladder support exactly these three; additional market locales require a re-seed.
- **Embeddings beyond 768-d** - the seeder and vector store are wired to `embeddinggemma-300m` at 768 dimensions; a different embedding model requires re-seeding.
- **Per-user or per-team corpus isolation** - the corpus is a single shared flat file; multi-tenant indexing is out of scope.
- **Streaming output** - the agent buffers all four stages before writing output; streaming partial results is out of scope.
- **Automated re-seeding on corpus change** - seeding is a manual `npm run seed` step; change-triggered re-indexing is out of scope.

---

## Further Notes

- The exercise brief specified 15–20 fragments; 120 were generated to support a statistically meaningful evaluation harness. The minimum requirement is met by the first 20 fragments of the corpus.
- The exercise allowed any LLM provider. All LLM calls go to a locally-running LM Studio instance (`http://localhost:1234`); no external API keys are required. The model is `google/gemma-4-e4b` for chat and `embeddinggemma-300m` for embeddings, configurable in `config/models.json` without code changes.
- The exercise requested four architecture decisions (embedding model, chunking strategy, retrieval method, agentic approach). These are documented in `docs/architecture.md`; the decision rationale is also captured in `docs/why.md` as an append-only log.
- Fragment content is not chunked - each fragment is treated as a single retrieval unit. This matches AEM's content fragment model, where a fragment is the smallest reusable authoring unit. Sub-fragment chunking was evaluated and rejected because it would split brand-guideline metadata from the content it applies to.
- The `schemaVersion: "1.0"` literal in `AgentOutput` is the contract anchor for any downstream consumer. Additive fields (e.g., `reusedFragments`) do not require a version bump; breaking changes to existing fields do.
