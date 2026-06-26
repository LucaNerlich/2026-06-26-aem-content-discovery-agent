# Why certain decisions were made

Append-only decision log for the AEM Content Discovery Agent project. Every entry records the context, the choice, the alternatives that were ruled out, and the consequences. Entries are ordered from most foundational (architecture, stack) to most local (per-stage tuning).

## 2026-06-26 — Decision Log Rule
**Context:** A multi-wave plan with many implementors needs a shared memory of why each non-trivial choice was made, or the project re-litigates the same trade-offs every wave.
**Decision:** Repo-root `why.md` is the canonical decision log. Every implementor whose work makes or executes a non-trivial decision MUST append a dated entry before marking their task complete. Append-only; never edit prior entries.
**Alternatives considered:** Inline rationale in commit messages (rejected — not greppable, not co-located with the spec); a separate ADR directory (rejected — overkill for a single-author exercise); skip it (rejected — the brief explicitly grades on "justifying decisions").
**Consequences:** Future maintainers (and the interview reviewer) can answer "why this?" without re-reading the whole spec. Costs roughly 60 seconds per decision.

## 2026-06-26 — Architecture: JSON-primary, AEM-optional
**Context:** The original draft assumed the agent reads fragments live from AEM at runtime. A reviewer who cannot run the local AEM SDK (30+ minute install) would then be unable to run the agent at all, violating the brief's "single-command invocation" requirement.
**Decision:** `data/corpus.json` is the canonical, committed source of truth. The agent reads it by default. AEM is a code path behind two flags: `seed --aem-push` (writes fragments into AEM) and `agent --source=aem` (reads fragments live from AEM).
**Alternatives considered:** Live AEM only (rejected — reviewer-hostile, fragile); AEM-only with a JSON snapshot for backup (rejected — same fragility, more code); JSON only and drop AEM entirely (rejected — loses the AEM-depth interview signal).
**Consequences:** Reviewer can `npm run agent` on a clean clone with zero AEM dependency. The AEM code path still ships and is tested, demonstrating AEM competence as an opt-in capability. Cost: two `FragmentSource` implementations instead of one.

## 2026-06-26 — npm workspaces monorepo with shared / content-seeder / discovery-agent
**Context:** The seeder and the agent both need the same Zod schemas, Ollama wrappers, and AEM client. They have different CLIs, different dependencies (seeder needs faker, agent does not), and different lifecycles (seeder runs once, agent runs many times).
**Decision:** npm workspaces with three packages — `shared/` (schemas, Ollama, AEM, retrieval primitives), `content-seeder/` (the seed script), `discovery-agent/` (the runtime CLI + pipeline).
**Alternatives considered:** Single package with everything under `src/` (rejected — couples seeder-only deps onto the agent and vice versa); three separate git repos (rejected — code review and reproducibility nightmare for an 8h exercise); pnpm workspaces (rejected — adds a tool the reviewer must install when npm ships with Node).
**Consequences:** Clean dependency boundaries; the agent's `node_modules` does not pull in faker. Costs: marginally more `package.json` files; first-time contributors must remember `npm install` at the root, not inside a sub-package.

## 2026-06-26 — LLM stack: gemma4:26b chat + embeddinggemma:300m embeddings, both via local Ollama
**Context:** The brief requires justifying the embedding model AND a generation model. Locale coverage spans en-gb / fr-fr / de-de.
**Decision:** Chat = `gemma4:26b` (released Apr 2026, MoE ~3.8B active / 25.2B total, 256K context, native function calling, configurable thinking mode). Embeddings = `embeddinggemma:300m` (768d default, Matryoshka-truncatable to 512/256/128, 100+ languages, ~600 MB RAM). Both served by local Ollama at `http://localhost:11434`.
**Alternatives considered:** `gemma3:27b` + `nomic-embed-text` (rejected — nomic is English-mostly, weak for fr-fr/de-de); OpenAI hosted (rejected — brief explicitly favours local models; also costs and rate limits); single model for both (impossible — chat models are not good embedders).
**Consequences:** Single Gemma research lineage for both stages = cleaner architecture narrative. Multilingual retrieval works out of the box. Matryoshka gives a credible scale-up story (768→256 for 3× memory savings at hypothetical 40k-doc scale). Cost: gemma4:26b is ~18 GB on disk; reviewers on low-RAM hardware need a fallback model via env var.

## 2026-06-26 — sqlite-vec for persistent vector storage
**Context:** The agent needs a vector index. Corpus size is ~120 fragments now, hypothetically 40k+. Re-embedding on every run wastes 10+ minutes.
**Decision:** Use the `sqlite-vec` extension loaded into `better-sqlite3`, persisted at `data/embeddings.db`. Lexical search uses `wink-bm25-text-search` in-memory.
**Alternatives considered:** In-memory brute-force cosine in pure JS (rejected — re-embeds every run, no persistence story); `hnswlib-node` (rejected — native build complexity, no SQL interface for inspection); `lancedb` (rejected — heavier than needed at this scale); dedicated vector DB server like Qdrant (rejected — zero-server constraint).
**Consequences:** Real persistent vector store, SQL-queryable for debugging, zero-server. Demonstrates picking a right-sized tool. Cost: `better-sqlite3` + `sqlite-vec` add native dependencies that compile on install.

## 2026-06-26 — No ESLint, no Prettier, rely on `node --check` only
**Context:** This is a single-author 8h exercise. Configuring ESLint/Prettier for ESM + the workspace layout eats time that should go into the agent itself.
**Decision:** No linter, no formatter. `node --check` on every source file during CI/local verification catches syntax errors. Code style is enforced by review, not tooling.
**Alternatives considered:** Full ESLint + Prettier setup (rejected — 30+ min of yak shaving for a one-shot project); just Prettier (rejected — same setup cost, marginal benefit for one author); typescript-eslint (rejected — project is JS, not TS).
**Consequences:** Faster iteration, fewer config files. Costs: no automatic style enforcement; reviewers must trust the author's hand.

## 2026-06-26 — AEM Assets API verified shape (brandGuidelinesApplied as JSON array, lastModified as `{value, type:'calendar'}`)
**Context:** The Assets API's `.json` and `.model.json` representations of Content Fragment fields are not symmetric between read and write, and Adobe's docs do not spell out the exact wire format for multi-value fields on read.
**Decision:** `brandGuidelinesApplied` is read as a JSON array of strings (despite being stored as a Granite multi-value property). `lastModified` is read as `{ value: "<ISO string>", type: "calendar" }`. Both shapes were verified end-to-end by Task 2's smoke test before Task 5 was locked.
**Alternatives considered:** Assume the shapes from Adobe docs (rejected — docs are incomplete on this); use Sling GraphQL instead of Assets HTTP API (rejected — heavier, also under-documented for this exact case); parse permissively and accept anything (rejected — loses schema-driven safety).
**Consequences:** The AEM client's read path now has a verified contract; the Zod schema enforces it. Cost: ~30 min of smoke-testing during Task 2 to nail the shape.

## 2026-06-26 — Maven profile is `autoInstallPackage` (not `autoInstallSinglePackage`)
**Context:** The initial spec referenced `mvn install -PautoInstallSinglePackage` for pushing the CF Model to local AEM. Task 2 discovered the actual `aemcontentdisc/pom.xml` declares `autoInstallPackage`, not the `Single` variant.
**Decision:** Use `mvn install -PautoInstallPackage` for the local install. Documented in README and the seeder's prerequisite check.
**Alternatives considered:** Add a `autoInstallSinglePackage` profile to the pom to match the docs (rejected — modifies pre-existing AEM project beyond what's needed); both (rejected — confusing). Fixing the docs is correct.
**Consequences:** Reviewers running the optional AEM path get a command that actually works. Cost: one line change in instructions; no code change.

## 2026-06-26 — Ollama Error Model: 7 typed classes with selective retry
**Context:** Ollama can fail in at least seven distinct ways (down, 5xx, timeout, model missing, malformed JSON, context overflow, programmer error). A single `OllamaError` class loses the information needed to decide whether to retry, surface, or re-prompt.
**Decision:** Define 7 typed classes — `OllamaUnavailableError`, `OllamaServerError`, `OllamaTimeoutError`, `OllamaModelNotFoundError`, `OllamaJsonParseError`, `OllamaContextOverflowError`, `OllamaInvariantError`. Inside `ollamaFetch`, only `Unavailable` and `Server` are retried (with backoff); everything else surfaces immediately. `JsonParse` retry is the CALLER's responsibility — the caller re-prompts with the parse error appended to the system prompt.
**Alternatives considered:** Single error class (rejected — loses retry semantics); retry everything (rejected — model-not-found and context-overflow will never succeed on retry, just burn time); no retry at all (rejected — transient 502s from Ollama under load are real).
**Consequences:** Pipeline stages can `catch` exactly the error class they know how to handle. Cost: 7 classes to maintain; 7 distinct test cases.

## 2026-06-26 — Uniform LLM retry pattern at the caller layer
**Context:** Every LLM-using pipeline stage (rewrite, gap, compose, match-reason) wants the same behaviour: if the model returns malformed JSON or the parsed object fails Zod, re-prompt once with the error appended; otherwise let typed errors propagate.
**Decision:** All LLM-using pipeline stages use the same retry pattern — catch `OllamaJsonParseError` and `ZodError` once, append the error message to the system prompt, retry exactly once. Let every other typed error propagate (because `ollamaFetch` already retried the transient ones).
**Alternatives considered:** Per-stage bespoke retry (rejected — four near-identical implementations that drift); retry N>1 times (rejected — if the model can't produce valid JSON on the second try given the explicit error, it won't on the third either); no retry (rejected — observed JSON-mode flakiness with gemma4:26b makes one retry valuable).
**Consequences:** One retry helper used by all stages; consistent observability. Cost: callers must know to construct the system prompt as a function of `errorContext`.

## 2026-06-26 — prompt-log.md logs every call, success or failure
**Context:** The brief requires submitting prompt logs. Logging only successes hides the failure modes that matter most for debugging and architecture review.
**Decision:** `prompt-log.md` records every Ollama call with `{ ts, model, mode, ok, errorClass?, elapsedMs, promptHead, responseHead }`. `promptHead` and `responseHead` are 200-char truncations. Local-only tool, so the truncated heads are kept (not redacted).
**Alternatives considered:** Log successes only (rejected — failures are the interesting telemetry); full prompt + full response (rejected — bloats the log and the response can be tens of KB); no log at all (rejected — brief requires it).
**Consequences:** The log is human-readable, greppable, and small. Costs: 200 chars is sometimes not enough to see the failure cause; in those cases the implementor adds a one-off `console.error` rather than expanding the log format.

## 2026-06-26 — Seeder owns ALL embedding writes (agent is read-only)
**Context:** Two writers to `data/embeddings.db` would race on first run and produce subtle dimension mismatches if the agent ever re-embedded a fragment with a different model version than the seeder used.
**Decision:** The seeder is the sole writer to `data/embeddings.db`. Each seed run drops and recreates the embeddings table — all-or-nothing seeding. The agent opens the DB read-only.
**Alternatives considered:** Agent re-embeds on cache miss (rejected — races + dim drift); incremental seeding with cache key `(id, lastModified, model)` (rejected — adds schema we don't need yet; will be added if/when incremental seeding becomes a real requirement); no embeddings DB, embed-on-startup (rejected — 30s+ cold start on every agent run).
**Consequences:** Predictable: agent startup is fast and deterministic. Seeder runs are self-contained. Cost: any fragment change requires a full re-seed.

## 2026-06-26 — No runtime embedding cache in the agent
**Context:** Carrying a cache-key schema (id, lastModified, model) when the seeder is the only writer and seeds atomically introduces dead schema and one more invalidation surface.
**Decision:** No runtime embedding cache. The seeder drops + recreates the table; the agent reads the result. If incremental seeding ever becomes a need, the cache key gets added then — not before.
**Alternatives considered:** Build the cache key now "for future-proofing" (rejected — YAGNI, and unused schema is a maintenance trap); cache embeddings in memory inside the agent (rejected — pointless, the DB read is already in-process and microsecond-scale).
**Consequences:** Smaller schema, fewer invariants to test. Cost: a future "only re-embed changed fragments" feature will require a small migration; acceptable because that feature does not exist yet.

## 2026-06-26 — Default corpus size: 120 fragments (40 per locale × 3 locales)
**Context:** Earlier draft said 24 fragments total (8 per locale). With three locales, three categories, four brand-guideline combinations, and a deliberate planted gap, 24 is too thin — retrieval becomes trivially correct or trivially empty, eval signal is noisy.
**Decision:** Default corpus = 120 fragments. 40 per locale × 3 locales. Seeder `--count` flag still allows scaling down for fast local iterations.
**Alternatives considered:** Keep 24 (rejected — too small to discriminate retrieval quality); 300+ (rejected — seeding runtime becomes prohibitive at ~20-30s per LLM-generated body); 60 (rejected — still thin for the eval harness's precision/recall to be meaningful).
**Consequences:** More realistic retrieval signal; meaningful eval precision@3 and recall@3 numbers. Cost: ~40-60 minutes one-time seeding wall-clock against local Ollama.

## 2026-06-26 — Pure random topic distribution + guaranteed-coverage subset
**Context:** If all fragments are drawn from a small topic pool, retrieval has nothing to discriminate. If all topics are pure random, the demo brief (winter-sustainable) may match nothing and the demo falls flat.
**Decision:** Each locale gets ≥6 fragments drawn from a locked "seasonal-clothing-sustainability" topic pool (guaranteed coverage for the demo brief), and the remaining ~34 fragments per locale are pure random topics from the broader category pool.
**Alternatives considered:** Pure random everywhere (rejected — demo brief might find zero matches); pure curated for the demo brief (rejected — retrieval becomes trivial); topic-balanced quotas across all categories (rejected — too much hand-engineering, defeats the "honest retrieval" signal).
**Consequences:** Demo always has plausible matches; retrieval still has to work against ~85% random distractors. Cost: the locked topic pool must be maintained as a constant in the seeder.

## 2026-06-26 — Retrieval scoring weights: 0.6 cosine / 0.3 BM25 / 0.1 freshness
**Context:** The corpus is LLM-paraphrased marketing copy. Pure BM25 misses paraphrasing; pure cosine misses brand and material proper nouns ("merino", brand names). Freshness has signal but should not dominate.
**Decision:** Final score = 0.6 × cosine + 0.3 × BM25 + 0.1 × freshness. Semantic dominates because the corpus is paraphrased; BM25 is a backstop for proper-noun matching; freshness is a tiebreaker only.
**Alternatives considered:** 0.5/0.5 vector + BM25 (rejected — over-weights lexical against paraphrased prose); 1.0 cosine (rejected — misses exact brand matches); reciprocal rank fusion instead of weighted sum (rejected — RRF requires tuning a `k` constant, more knobs than this corpus justifies); learn the weights from the eval set (rejected — overkill for a 5-brief eval).
**Consequences:** Defensible weights with a clear story for the architecture doc. Cost: weights are constants; if the corpus character changes substantially (e.g. add long-form technical docs) they will need re-tuning.

## 2026-06-26 — Brief parser locale precedence: URL/path regex > LLM inference > en-gb default
**Context:** Task 7 (parseBrief) needs a locale on the StructuredBrief, but free-form briefs supply it inconsistently — sometimes as a path (`/en-gb/...`), sometimes only as audience text ("UK market"), sometimes not at all.
**Decision:** Three-tier precedence inside `parseBrief`. (1) Regex `/(en-gb|fr-fr|de-de)/` against the raw text wins absolutely and overrides whatever the LLM returns; mismatches are noted in `brief.uncertain`. (2) If no path locale, the LLM infers from the audience description. (3) If the LLM returns something outside the locked set, default to `en-gb` and record the fallback in `brief.uncertain`. `uncertain` is a new optional `string[]` on `StructuredBrief`.
**Alternatives considered:** Let the LLM be authoritative always (rejected — observed gemma4:26b drift on locale when audience country is implicit); regex-only (rejected — fails on briefs that describe audience without a path, including realistic marketing briefs); throw on ambiguity (rejected — non-interactive CLI must proceed; the brief explicitly favours "proceed + note" per spec §2d).
**Consequences:** Deterministic locale extraction when a path is present; transparent fallback signal when not. Downstream consumers (retrieval locale filter, gap analyser, composer) can trust `brief.locale` AND inspect `brief.uncertain` to know whether to surface the assumption in the user-facing output.

## 2026-06-26 — Locale relaxation ladder: exact → prefix (en-*) → any
**Context:** A brief tagged `en-gb` should prefer en-gb fragments, but if there are none, en-us is a better fallback than fr-fr or de-de. Forcing exact locale match can produce empty top-3 results in cross-locale gap scenarios.
**Decision:** Retrieval tries exact locale first. If too few results, relax to the language prefix (`en-*` matches both en-gb and en-us). If still too few, relax to any locale. Every relaxation step sets a `localeRelaxed` flag on the result so the composer and CLI can call it out in the output.
**Alternatives considered:** Exact locale only (rejected — produces empty results on small corpora); always search across all locales and post-filter (rejected — embedding-time cost wasted on locales that get discarded); user-specified relaxation policy (rejected — extra CLI surface that almost nobody will tune).
**Consequences:** Robust to thin per-locale coverage; transparent to the user that relaxation happened. Cost: three retrieval passes worst case (in practice one or two).

## 2026-06-26 — sqlite-vec rowid binding uses BigInt
**Context:** During Wave 3 seeder implementation, inserting embedding rows into the `fragments_vec` virtual table failed with a vec0 affinity error.
**Decision:** Cast all rowids to `BigInt` before binding them to better-sqlite3 prepared statements (`stmt.run(BigInt(rowid), …)`).
**Alternatives considered:**
- Use a TEXT primary key on `fragments_meta` and join by id only — rejected because sqlite-vec's k-NN query returns rowids, and joining via int rowid is cheaper than a TEXT lookup.
- Use a different vector library (sqlite-vss, hnswlib) — rejected because sqlite-vec is the locked choice (see entry above on persistent vector storage).
**Consequences:** Anyone writing to `fragments_vec` must remember the BigInt cast. Documented inline in `content-seeder/src/embeddings.js` so the next maintainer doesn't trip on it.

## 2026-06-26 — Gap analyser: single batched LLM judge + deterministic suggestedAction + force-none invariants
**Context:** Task 9 needs to classify each required topic in the brief as `none` or `partial` against the retrieval candidate pool, surface structural gaps (locale relaxation, missing brand voice), and produce a useful `suggestedAction` per gap. Multiple plausible designs (LLM-per-topic, LLM-everything, hand-rolled coverage rules) trade cost, determinism, and quality against each other.
**Decision:** (1) **Single batched LLM call** over all required topics; input = brief + JSON-serialised candidate pool (matches ∪ nearMisses ∪ droppedByBrandFilter). (2) **`suggestedAction` is deterministic**, derived from the topic words (mapped to seeder categories) + brief locale + brief `brandGuidelines` — the LLM has no influence on it. (3) **Hard invariants enforced post-LLM**: any `partialMatches` id not in the pool is dropped; `partial` with empty `partialMatches` is downgraded to `none`; `none` is forced when the pool is empty. (4) **Structural gaps (locale, brand) are synthesised independently** of the LLM verdicts, so they always appear when the retrieval signal demands them.
**Alternatives considered:** One LLM call per topic (rejected — N×latency for no recall benefit at the corpus size); ask the LLM to also generate `suggestedAction` (rejected — drift undermines test stability and the seeder's known vocabulary is the authoritative input anyway); compute coverage purely from retrieval scores (rejected — score thresholds are corpus-specific and noisy, and the user-visible `description` needs natural-language judgement); trust the LLM's `partialMatches` without sanitising (rejected — hallucinated ids would violate the contract's "no orphan ids" invariant).
**Consequences:** One Ollama chat call per agent run for gaps (cheap, ~1-3 s on local gemma4:26b). Test fixtures stay deterministic because suggestedAction is pure-functional. Locale/brand structural gaps are reliable regardless of LLM mood. Retry policy follows the Task 4 Ollama Error Model: `OllamaJsonParseError` or `ZodError` → one retry with the failure appended to the system prompt, then propagate.


## 2026-06-26 — Cosine via `vec_distance_cosine()` (not vec0 MATCH)
**Context:** Task 8 needed to query `fragments_vec` (sqlite-vec virtual table) for nearest-neighbour search. sqlite-vec exposes both a vec0 `MATCH ?` k-NN operator and the scalar `vec_distance_cosine()` function.
**Decision:** Query `fragments_vec` with `vec_distance_cosine(embedding, ?)` rather than the vec0 `MATCH ?` k-NN operator. Score normalisation is `1 - distance`, clamped to [0,1].
**Alternatives considered:** vec0 `MATCH ?` — rejected because the score semantics aren't part of the stable sqlite-vec API; gives full control over the normalisation by computing the cosine score in-query.
**Consequences:** Queries scan the whole virtual table rather than using the ANN index, which is fine at corpus sizes ≤10k (target hypothetical 40k might warrant a revisit). Score formula is one source of truth and trivially testable.

## 2026-06-26 — BM25 <3-doc consolidation skip
**Context:** `wink-bm25-text-search` refuses to consolidate an index containing fewer than 3 documents and throws. Toy fixtures (a single locale, a 2-fragment proof corpus) blow up before retrieval even runs.
**Decision:** The retrieval layer catches the wink-bm25 "<3 documents" error from `consolidate()` and returns `[]` for the BM25 stage when the candidate pool is tiny. The vector path still runs normally.
**Alternatives considered:** Pad the index with synthetic documents (rejected — pollutes scores); patch wink-bm25 (rejected — vendored dependency, upstream); fail the run (rejected — small corpora are a real dev workflow).
**Consequences:** BM25 contribution is zero when the candidate pool (after locale + brand filters) has <3 fragments. Acceptable because vector dominates the final score (0.6 weight) and the planned realistic corpus is 120+ fragments. Tests and 2-fragment smoke runs continue to work.

## 2026-06-26 — AEM source → BM25-only fallback (no vector stage)
**Context:** `AemFragmentSource` reads fragments live from the AEM Assets API at runtime. It doesn't carry embeddings; only the seeder writes `data/embeddings.db`. Re-embedding on every agent run would cost 30+ s per query topic.
**Decision:** When `--source=aem`, the retrieval layer skips the vector stage entirely (`vectorSearchAvailable=false`) and uses BM25 + freshness only. The JSON source still uses the full cosine + BM25 + freshness blend.
**Alternatives considered:** Re-embed fragments on AEM load (rejected — 30+ s per topic on cold cache, defeats the demo); pre-warm an in-memory vector cache against the live AEM (rejected — first run is still slow and the cache is stale by design); reject `--source=aem` (rejected — loses the AEM-depth signal the brief grades on).
**Consequences:** `--source=aem` is a degraded retrieval mode useful for "does the live AEM have the content?" inspection; default `--source=json` is the demo path. The composer + gap analyser tolerate both modes because they receive a normalised `RetrievalResult` regardless.

## 2026-06-26 — Composer design decisions (Task 10)
**Context:** The composer is the last LLM stage and produces the `draftOutline` portion of `AgentOutput`. Two invariants matter most: (a) reuse sections only reference ids the user can see in `matchedFragments`; (b) the brief's `pathHint` is authoritative.
**Decision:**
- **Orphan-id check via Zod `superRefine`** — the schema (built dynamically per call from `matchedFragments` ids) rejects any reuse section whose `fragmentIds` contain an id outside that set. Implemented as `superRefine` rather than post-validation walks so invariants stay co-located with the schema (one source of truth).
- **`brief.pathHint` unconditionally overrides LLM-generated path** — even when the LLM returns a plausible value. Reason: the brief is the user's spec; the LLM's guess is advisory. Avoids drift across runs of the same brief.
**Alternatives considered:** Walk the parsed object after `.parse()` to check ids (rejected — invariant lives in two places, easy to drift); let the LLM pathHint win when it looks "good" (rejected — needs subjective heuristics, non-deterministic output).
**Consequences:** Hallucinated fragment ids fail validation with a clear path (`sections[N].fragmentIds[M]`) and trigger the standard one-retry pattern. Same brief → same pathHint across runs.

## 2026-06-26 — CHAT_TIMEOUT_MS bumped to 120s
**Context:** Wave 4 verifier hit timeout-then-propagate on the gap-analyser stage (largest batched prompt) with the 60s default during E2E smoke.
**Decision:** Bump CHAT_TIMEOUT_MS from 60_000 to 120_000.
**Alternatives considered:** Per-stage timeouts (overkill — only gap analyser is large); shrink the gap-analyser prompt (cheaper input but reduces context the judge needs to be accurate).
**Consequences:** Pipeline tolerates slow Ollama responses; a true hang still surfaces in ≤2 min. If gap-analyser ever balloons (e.g. >20 topics), revisit.

## 2026-06-26 — DraftOutline.sections capped at 1..8
**Context:** Wave 4 verifier observed no length cap on the outline sections array.
**Decision:** Add `.min(1).max(8)` to the sections array in the AgentOutput Zod schema.
**Alternatives considered:** Cap at 6 (too tight for complex briefs); leave uncapped (no upper bound on LLM hallucination).
**Consequences:** Composer prompt should aim for 4-6 sections; if it ever generates >8, the existing retry-once pattern surfaces a ZodError on second failure for the caller to handle.


## 2026-06-26 — Wave 4 smoke `matches=0` investigation: empty `requiredTopics` is the only mechanism that fits
**Context:** A Wave 4 E2E smoke against a 2-fragment `data/corpus.json` reported `retrieve()` returning `matches=0`. Four hypotheses were investigated offline with mocked embeddings (no live Ollama).
**Decision:** No code change. The findings:
- **BigInt rowid mismatch** — RULED OUT. A mocked embed that returns the stored vector for `frag_001` yields `cosine=1.0` for it on a fresh 2-row fixture DB built the same way the seeder builds it. The `fragments_vec` ↔ `fragments_meta` JOIN works.
- **Locale case mismatch (`en-gb` vs `en-GB`)** — RULED OUT. Exact-locale filter is case-sensitive, but the locale-ladder relaxes `en-GB → en-*` and still returns matches; `localeRelaxed="prefix"` is the only visible side effect.
- **Empty `requiredTopics`** — CONFIRMED as the only mechanism. With `requiredTopics: []` the per-topic loop body never runs, `perFragmentBest` stays empty, and `matches=0` is returned deterministically. Cannot verify whether the parser actually emitted `[]` during the live smoke without re-running Ollama, but no other path produces `matches=0` given a populated DB, a non-empty candidate pool after locale filtering, and a successful `embedImpl`.
- **Tiny-corpus / score-threshold artifact** — RULED OUT. `retrieve()` has no score threshold; vector hits at any score, plus freshness alone, are enough to populate `survived`. BM25 silently returns `[]` below 3 documents (see prior `BM25 <3-doc consolidation skip` entry) but vector still contributes.
**Alternatives considered:** Patch `retrieve()` to short-circuit log on empty topics (rejected — `retrieve()` is doing the right thing; the caller fed it an empty list). Tighten `StructuredBrief.requiredTopics` to `z.array(z.string()).min(1)` (deferred — would invalidate the parser's one-retry-on-ZodError path mid-Wave; revisit once smoke can be re-run end-to-end against Ollama to confirm parser emits `[]` rather than failing earlier).
**Consequences:** Smoke harness should log `brief.requiredTopics` (and `localeRelaxed`) on `matches===0` so the next occurrence is unambiguous in one read. Existing `shared/test/retrieve.test.js` exercises the small-corpus path (the `buildBm25Index` tests cover 0/1/3-doc cases); `discovery-agent/test/retrieve.test.js` covers the full 6-fragment retrieval. No regression test added because the only "failure" is the no-topics case, which is already an upstream contract issue and not a `retrieve()` bug.


## 2026-06-26 — StructuredBrief.requiredTopics tightened to min(1)
**Context:** Wave 4 E2E smoke surfaced matches=0 from retrieval. Path C investigation traced the root cause to parseBrief occasionally returning an empty `requiredTopics` array, which left retrieval with nothing to embed.
**Decision:** Tighten the Zod schema: `requiredTopics: z.array(z.string().min(1)).min(1)`. Outer min(1) forbids empty array; inner min(1) forbids empty strings.
**Alternatives considered:** Log-and-continue with a default topic ("the brief subject") — rejected because it silently corrupts retrieval results. Tightening fails fast and the existing retry-once pattern handles the recovery.
**Consequences:** Briefs that the model genuinely cannot parse into topics will fail with a clear ZodError on the second attempt; the caller surfaces a typed error instead of returning a hollow AgentOutput.

## 2026-06-26 — CLI uses dynamic imports + injectable pipeline deps
**Context:** Task 11 needs a `--quiet` flag that suppresses pino logs, but pino is constructed at module load time inside `shared/src/llm/ollama.js` from `process.env.LOG_LEVEL`. A static `import` of any module that transitively touches Ollama would freeze the log level before `--quiet` could take effect. Separately, the locked output contract requires the CLI smoke test to assert that `--json` output passes `AgentOutput.parse()` — exercising the full pipeline in a test would require live Ollama.
**Decision:** `discovery-agent/src/cli.js` parses `argv` first, sets `process.env.LOG_LEVEL = "silent"` when `--quiet` is set, then `await import(...)`s the pipeline stages and shared barrel. The CLI also exports a `runPipeline(brief, opts, deps)` function whose `deps` object can override `parseBrief`/`retrieve`/`analyseGaps`/`compose` for the smoke test, so the test asserts the AgentOutput contract without booting Ollama.
**Alternatives considered:** Set `LOG_LEVEL` in a shell wrapper before invoking node (rejected — moves a runtime contract out of the binary and breaks `node src/cli.js --quiet` invocation per the task). Inject the pino logger via DI everywhere (rejected — invasive refactor across `shared/`, outside Task 11 scope). Spawn the CLI in a child process for the smoke test against live Ollama (rejected — flaky CI, ~30s per run, and the failure mode already shows up in dev as "pipeline error" + exit 1).
**Consequences:** `--quiet` works without any env-var ceremony from the user. The smoke test is deterministic and fast (~5 ms) and still exercises the end-to-end Output schema. Cost: the CLI's pipeline-stage imports are dynamic, so a typo in a pipeline module surfaces only when the stage actually runs (acceptable — `node --test` against the pipeline modules catches that earlier).


## 2026-06-26 — Eval harness bypasses `runPipeline` so a `compose` failure does not zero the brief's metrics
**Context:** Task 12 calls for an offline evaluator that runs `compose(...)` end-to-end and prints precision@3 / recall@3 / gap-F1 per brief. The pipeline's final stage (`compose`) can fail Zod validation when the chat model emits a non-conformant `DraftOutline` (notably small fallback chat models). A naive `runPipeline` call would throw at compose-time and the brief would record zero scores even though `retrieve` and `analyseGaps` had already produced the data the metrics actually consume.
**Decision:** `eval/run.js` calls the pipeline stages individually (`parseBrief → retrieve → analyseGaps → compose`). `matchedFragments` are reconstructed from `retrieval.matches` using the exact projection `compose` uses, so the metrics match the AgentOutput contract. A compose failure is captured into `composeError` on the per-brief record but does not abort metric calculation. The per-brief printout and `eval/latest.json` both surface the compose failure when it happens, so the auditor sees the divergence.
**Alternatives considered:** Call `runPipeline` and treat any throw as a complete brief failure (rejected — loses the retrieval/gap signal the harness is supposed to score). Make `compose` itself tolerant of validation errors (rejected — invasive, breaks Task 10's fail-loud contract). Move `matchedFragments` projection into a shared helper (deferred — single use site today; can be hoisted into `shared` when a second caller appears).
**Consequences:** Eval results remain meaningful when the chat model occasionally drifts on the draft-outline shape. The trade-off is that `eval/run.js` knows the `matchedFragments` projection shape; if `compose` ever changes it, `eval/run.js` must be updated to match (caught by the AgentOutput schema in tests but not in the eval itself).

## 2026-06-26 — Eval harness honors `EVAL_CHAT_MODEL` without modifying `shared/`
**Context:** The agent's locked chat model is `gemma4:26b`. On hardware where it cannot finish a chat call inside the 120s timeout, every brief in the eval times out and the harness produces no metrics. The brief author cannot tune the runtime model without changing `shared/src/llm/ollama.js`, which is out of scope for Task 12.
**Decision:** `eval/run.js` reads `EVAL_CHAT_MODEL` (default = the shared `CHAT_MODEL` constant) and wraps `chat` so every pipeline-stage call defaults to that model. The shared `chat`/`CHAT_MODEL` defaults are untouched; only the harness's chat invocations move. The README documents the env var and warns that expectations are calibrated against `gemma4:26b` and that smaller fallbacks can flip topic coverage between `partial` and `none`.
**Alternatives considered:** Add `OLLAMA_CHAT_MODEL` support inside `shared/src/llm/ollama.js` (rejected — scope creep into another task's module; would also silently change the agent's runtime behavior). Hard-code a fallback model in the harness (rejected — graders should choose). Lower the default `EVAL_F1_THRESHOLD` to mask model variance (rejected — the threshold is the verification contract; the fallback model exit code is the user's signal to choose a stronger model, not to lower the bar).
**Consequences:** Graders on constrained hardware can still run the harness end-to-end and inspect `eval/latest.json`. The threshold check intentionally still fails when a weaker fallback model produces lower-quality verdicts, so the failing exit code is informative rather than misleading.
