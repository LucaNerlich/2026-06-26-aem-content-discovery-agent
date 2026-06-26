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

## 2026-06-26 — Locale relaxation ladder: exact → prefix (en-*) → any
**Context:** A brief tagged `en-gb` should prefer en-gb fragments, but if there are none, en-us is a better fallback than fr-fr or de-de. Forcing exact locale match can produce empty top-3 results in cross-locale gap scenarios.
**Decision:** Retrieval tries exact locale first. If too few results, relax to the language prefix (`en-*` matches both en-gb and en-us). If still too few, relax to any locale. Every relaxation step sets a `localeRelaxed` flag on the result so the composer and CLI can call it out in the output.
**Alternatives considered:** Exact locale only (rejected — produces empty results on small corpora); always search across all locales and post-filter (rejected — embedding-time cost wasted on locales that get discarded); user-specified relaxation policy (rejected — extra CLI surface that almost nobody will tune).
**Consequences:** Robust to thin per-locale coverage; transparent to the user that relaxation happened. Cost: three retrieval passes worst case (in practice one or two).