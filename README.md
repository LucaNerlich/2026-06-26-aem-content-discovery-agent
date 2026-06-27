# AEM Content Discovery Agent

An Adobe AI Engineering interview deliverable: a Node CLI that ingests a
free-form content brief, retrieves relevant fragments from a local corpus using
hybrid vector + BM25 search, asks a local LLM to judge content gaps, and
returns a strict three-block `AgentOutput` (top matches, gaps, draft outline).
The original brief PDF lives at the
[repo root](AEM_Content_Discovery_Agent_Brief.pdf); the decision log is in
[`why.md`](./why.md).

## Prerequisites

- **Node 22** (`.nvmrc` is checked in — `nvm use` picks it up).
- **Ollama** running locally on `http://localhost:11434`, with these models pulled:
  - `qwen3.5:9b` (chat, ~6 GB on disk; runs on 16 GB unified memory)
  - `embeddinggemma:300m` (768-d embeddings, ~600 MB)
  - *(Optional premium alternative)* `gemma4:26b` (~18 GB on disk; needs ~32 GB
    unified memory). Swap into `config/models.json` if you have the headroom.
- **sqlite3** native toolchain (`better-sqlite3` + `sqlite-vec` build on install).
- *(Optional, for the AEM round-trip only)* JDK 21, Maven 3.9, AEM Cloud SDK
  2026.6 at `http://localhost:4502` with `admin:admin`.

## Quickstart (JSON-primary path)

The default path needs no AEM and no network beyond Ollama. Copy-paste:

```bash
nvm use && npm install
ollama pull qwen3.5:9b && ollama pull embeddinggemma:300m

npm run seed                                       # writes data/corpus.json + data/embeddings.db
npm run agent eval/briefs/winter-sustainable.txt   # Markdown to stdout
npm run agent eval/briefs/winter-sustainable.txt -- --json   # canonical AgentOutput
npm run eval                                       # full evaluation harness
npm test                                           # unit tests across all workspaces
```

`data/corpus.json` and `data/embeddings.db` are committed, so the agent is
runnable without running the seeder if you accept the locked corpus seed
(`DEMO_SEED=20260626`). See [`eval/README.md`](./eval/README.md) for how the
harness scores precision/recall/gap-F1.

### Tuning the chat model and timeout

The shipped default is `qwen3.5:9b` — fast enough for the alpha-run harness
on consumer hardware. To swap models edit
[`config/models.json`](./config/models.json) (one file, no rebuild). The
default chat timeout is 120 s; override it for long-running stages via
`CHAT_TIMEOUT_MS`. The eval harness additionally honours `EVAL_CHAT_MODEL`:

```bash
EVAL_CHAT_MODEL=qwen2.5-coder:1.5b npm run eval
CHAT_TIMEOUT_MS=300000 npm run alpha   # 5 min per chat call
```

`gemma4:26b` is supported as a premium alternative when the hardware can
sustain it; expect richer reuse-vs-NEW decisions but ~2-4× wall-clock per
brief.

### Thinking-mode models (qwen3-family)

`qwen3.5:9b` and its siblings ship with native "thinking" — the model
optionally emits a `<think>...</think>` block before the user-facing reply.
The pipeline accommodates this rather than forcing it off:

- **Think-stripper is always on.** `shared/src/llm/chat.js` unconditionally
  strips a leading `<think>...</think>` block from every reply (regex
  `/^\s*<think>([\s\S]*?)<\/think>\s*/i`) before downstream parsing.
  Downstream consumers never see the think tokens. A reply that opens
  `<think>` without a closing tag is treated as a truncated response and
  throws `OllamaInvariantError("Response truncated mid-think — increase
  num_predict or set DISABLE_THINKING_MODE=true")`.
- **Per-stage `num_predict` caps** give the model enough headroom to think
  AND emit the structured reply. The seeder fragment call uses 3000;
  `parseBrief` 2500; `analyseGaps` 4000; `compose` 6000. Edit these
  constants in the respective files if you swap to a chattier or quieter
  model.
- **`DISABLE_THINKING_MODE` escape hatch (off by default).** Set this env
  var to anything truthy AND use a `qwen3*` chat model to have `chat()`
  pass `think: false` to Ollama. Use this only if a stage repeatedly fails
  with "truncated mid-think" and the `num_predict` headroom does not help:

  ```bash
  DISABLE_THINKING_MODE=true npm run alpha
  DISABLE_THINKING_MODE=true npm run seed -- --seed=20260626
  ```

  The auto-detect intentionally only matches `qwen3*`; non-qwen3 models are
  unaffected by the env var.

## Architecture

```
brief.txt  ──► parseBrief ──► retrieve ──► analyseGaps ──► compose ──► AgentOutput
                 (chat)        (embed +       (chat)         (chat)
                                BM25 +
                                freshness)
```

- **`parseBrief`** — LLM extracts `StructuredBrief` (audience, locale, tone,
  brand-guideline enum, required topics, path hint). Locale auto-detected from
  any `/locale/` path in the brief.
- **`retrieve`** — Locale ladder (exact → language prefix → any) feeds a fused
  score `0.6·cosine + 0.3·bm25 + 0.1·freshness` over the candidate fragments.
  Returns `matches` (top-3), `nearMisses`, and `droppedByBrandFilter`.
- **`analyseGaps`** — LLM judge verdicts each required topic as `none|partial`
  against the candidate pool; structural locale + brand-coverage gaps are
  appended deterministically.
- **`compose`** — LLM drafts a 4–6 section outline; each section is strictly
  `kind: "reuse"` (with ids from `matches` only) or `kind: "new"` (with a
  `sourcingHint`). Schema rejects orphan ids; retries once on validation error.

The full pipeline walkthrough, schema definitions, and the Adobe MCP /
sqlite-vec / Matryoshka discussion live in
[`docs/architecture.md`](./docs/architecture.md).

## Output contract

```js
AgentOutput = {
  schemaVersion: "1.0",
  brief: StructuredBrief,
  matchedFragments: MatchedFragment[0..3],   // id, path, score [0..1], reason ≤140 chars
  gaps: Gap[],                               // topic, coverage, description, partialMatches[], suggestedAction
  draftOutline: {
    title, pathHint,
    sections: SectionUnion[1..8]             // ReuseSection | NewSection
  }
}
```

Zod schemas: [`shared/src/schema/`](./shared/src/schema/) — `brief.js`,
`corpus.js`, `fragment.js`, `output.js`.

## Sample run

A real end-to-end output for `eval/briefs/winter-sustainable.txt` (Markdown
plus the corresponding canonical JSON) lives in
[`docs/sample-run.md`](./docs/sample-run.md). The Markdown render's `**NEW**`
marker on outline sections corresponds to `kind: "new"` in the JSON.

## Eval results

[`npm run eval`](./eval/README.md) runs the pipeline against five hand-written
briefs and scores `precision@3 / recall@3 / gap-F1`. The latest run is
committed at [`eval/latest.json`](./eval/latest.json). At time of writing
(seed `20260626`, chat model `qwen2.5-coder:1.5b`):

| Brief                       | precision@3 | recall@3 | gap-F1 |
|-----------------------------|-------------|----------|--------|
| de-de-berlin-street         | 1.00        | 0.75     | 0.44   |
| en-gb-technical-outerwear   | 0.33        | 0.25     | 0.50   |
| en-us-holiday-gifting       | 1.00        | 0.60     | 0.50   |
| fr-fr-knitwear              | 0.67        | 0.50     | 0.67   |
| winter-sustainable          | 0.00        | 0.00     | 0.67   |
| **aggregate**               | **0.60**    | **0.42** | **0.56** |

Numbers improve materially with larger chat models (e.g. `gemma4:26b`); the
table above is from the smaller fallback used to keep the eval harness green
on constrained hardware.

## Optional AEM round-trip

To exercise the AEM code path end-to-end against the local AEM SDK:

1. Start the AEM SDK at `http://localhost:4502` (admin:admin) and install the
   project package:

   ```bash
   cd aemcontentdisc && mvn clean install -PautoInstallPackage
   ```

2. Push the corpus into AEM as Content Fragments:

   ```bash
   npm run seed -- --aem-push --reset --seed=20260626
   ```

   `--reset` removes any prior `/content/dam/aemcontentdisc/{locale}/` tree
   first; the seeder then creates one CF per fragment using the Sling POST
   servlet against the `discovery-fragment` CF Model.

3. Run the agent against the live AEM instance:

   ```bash
   npm run agent eval/briefs/winter-sustainable.txt -- --source=aem
   ```

In `--source=aem` mode the agent reads fragments live via the Assets HTTP API
and skips the precomputed vector index — BM25 alone scores retrieval. The
JSON-primary path is the supported default for graders; the AEM path is here
to demonstrate the read/write round-trip without making AEM a prerequisite.

## Repo layout

```
.
├── shared/                       npm workspace: schemas, LLM, AEM, retrieval primitives
├── content-seeder/               npm workspace: deterministic corpus generator (npm run seed)
├── discovery-agent/              npm workspace: CLI + pipeline (npm run agent)
├── eval/                         F1 harness (npm run eval) + briefs + expectations
├── config/models.json            single source of truth for chat/embedding model selection
├── data/
│   ├── corpus.json               canonical 72-fragment corpus (seed 20260626)
│   └── embeddings.db             sqlite-vec persisted 768-d vectors
├── docs/
│   ├── architecture.md           full pipeline + schema + Adobe MCP notes
│   ├── sample-run.md             real end-to-end output for winter-sustainable.txt
│   └── prompt-log.md             every system/user prompt template + tuning notes
├── aemcontentdisc/               AEM project (CF Model, Maven build, optional)
├── why.md                        dated decision log (append-only)
├── prompt-log.md                 auto-appended runtime chat transcript
└── AEM_Content_Discovery_Agent_Brief.pdf
```

## Design notes (short form)

- **JSON-primary, AEM-optional.** `data/corpus.json` is the canonical source of
  truth; AEM is a code path behind two flags (`seed --aem-push`,
  `agent --source=aem`). A reviewer without local AEM can still run the agent.
- **`sqlite-vec` over in-memory cosine.** At 72 fragments either would work;
  sqlite-vec gives persistent vectors, SQL-inspectability, and a clean scale
  path to 40k+ fragments without changing the retrieval API.
- **`qwen3.5:9b` for chat (default).** Released 2026, ~9 B dense, strong
  JSON-mode discipline and multilingual coverage (matters for fr-fr / de-de
  briefs). Fits ~16 GB unified memory with comfortable per-call latency.
  Premium alternative `gemma4:26b` (MoE ~3.8 B active / 25.2 B total,
  256 K context) configurable via `config/models.json`.
- **`embeddinggemma:300m` for embeddings.** 768-d default, **Matryoshka**-
  truncatable to 512/256/128 dimensions, 100+ languages, ~600 MB RAM. Same
  Gemma research lineage as the chat model for narrative consistency.
- **Locale ladder.** Exact `brief.locale` → language prefix (`en-*` for
  `en-gb`) → all locales. Each relaxation surfaces as a structural gap, so
  graders see when the agent fell back instead of finding exact-locale content.
- **No linter, no formatter.** `node --check` only. Single-author 8h exercise;
  config files trade poorly against pipeline depth.

The detailed rationale for every non-trivial choice is in
[`why.md`](./why.md).

## External documentation

- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/local-development-with-ai-tools
- https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/ai-in-aem/mcp-support/using-mcp-with-aem-as-a-cloud-service
- https://ollama.com/library/gemma4
- https://ollama.com/library/embeddinggemma