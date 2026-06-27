# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (run at repo root, not inside sub-packages)
npm install

# Seed the corpus and vector DB (writes data/corpus.json + data/embeddings.db)
npm run seed

# Run the discovery agent against a brief
npm run agent eval/briefs/winter-sustainable.txt
npm run agent eval/briefs/winter-sustainable.txt -- --json   # canonical AgentOutput JSON

# Run all tests across all workspaces
npm test

# Run a single workspace's tests
node --test --test-reporter spec 'shared/test/**/*.test.js'
node --test --test-reporter spec 'discovery-agent/test/**/*.test.js'
node --test --test-reporter spec 'content-seeder/test/**/*.test.js'

# Run the eval harness (precision@3 / recall@3 / gap-F1 across 8 briefs)
npm run eval

# Run the full-run harness (all briefs, captures JSON + Markdown to runs/full-run/)
npm run full-run
```

There is **no lint or format step** — the project uses `node --check` only for syntax validation.

### Key env vars

| Var | Default | Purpose |
|-----|---------|---------|
| `CHAT_TIMEOUT_MS` | `120000` | Per-call chat timeout (ms) |
| `OLLAMA_HOST` | `http://localhost:1234` | Base URL of the LM Studio server (env var name kept for backwards compatibility) |
| `EVAL_CHAT_MODEL` | value in `config/models.json` | Override chat model for eval runs |
| `DISABLE_THINKING_MODE` | unset | Set truthy to send `think: false` to qwen3 models |
| `LOG_LEVEL` | info | Pino log level; `silent` suppresses all pino output |

Model selection lives in **`config/models.json`** — one file, no rebuild needed.

## Architecture

The agent implements a 4-stage pipeline:

```
brief.txt → parseBrief → retrieve → analyseGaps → compose → AgentOutput
              (LLM)       (embed +      (LLM)        (LLM)
                           BM25 +
                           freshness)
```

All four stages live in `discovery-agent/src/pipeline/`. The CLI entry point is `discovery-agent/src/cli.js`.

### Monorepo layout

Three npm workspaces:
- **`shared/`** — schemas (Zod), LM Studio client, AEM client, retrieval primitives. Imported as `@aemdisc/shared`.
- **`content-seeder/`** — deterministic corpus generator (`npm run seed`). Sole writer to `data/embeddings.db`.
- **`discovery-agent/`** — the runtime CLI + 4-stage pipeline.

### Retrieval

Hybrid fused score: `0.6·cosine + 0.3·BM25 + 0.1·freshness`. Vector search via `sqlite-vec` (persistent, read-only in agent). BM25 via `wink-bm25-text-search` in-memory. The seeder is the **only** writer to `data/embeddings.db` — the agent opens it read-only.

Locale ladder: exact → language prefix (`en-*`) → any. Each fallback surfaces as a structural gap in the output.

### Fragment sources

Two implementations behind the `FragmentSource` interface:
- `JsonFragmentSource` (default, `--source=json`) — reads `data/corpus.json`.
- `AemFragmentSource` (`--source=aem`) — reads live from AEM Assets HTTP API.

### LLM layer (`shared/src/llm/`)

- `chat.js` — posts to the OpenAI-compatible `/v1/chat/completions` endpoint served by LM Studio. Strips `<think>...</think>` blocks. Every call (success or failure) is appended to `prompt-log.md`.
- `embed.js` — posts to LM Studio's OpenAI-compatible `/v1/embeddings` endpoint.
- `ollama.js` — host resolution and shared `ollamaFetch` helper. The `Ollama*` naming is retained from an earlier Ollama-backed implementation; today the client talks to LM Studio at `http://localhost:1234` (override with `OLLAMA_HOST`).
- `errors.js` — 7 typed error classes (`OllamaUnavailableError`, `OllamaServerError`, `OllamaTimeoutError`, `OllamaModelNotFoundError`, `OllamaJsonParseError`, `OllamaContextOverflowError`, `OllamaInvariantError`). Only `Unavailable` and `Server` are retried inside `ollamaFetch`. `JsonParseError` retry is the caller's responsibility (re-prompt with error context).

### Output contract

All stages produce / consume Zod-validated types from `shared/src/schema/`:
- `brief.js` → `StructuredBrief`
- `fragment.js` → `MatchedFragment`
- `output.js` → `AgentOutput` (`schemaVersion: "1.0"`, `matchedFragments[0..3]`, `gaps[]`, `draftOutline.sections[1..8]`)

`compose` validates its output with Zod and retries once on failure before surfacing the error.

### Eval harness

`eval/run.js` runs all 8 briefs and writes scores to `eval/latest.json`. Expectations reference deterministic fragment ids (`frag_001`, `frag_002`, …) that only stay stable when the seeder uses `DEMO_SEED=20260626`. If the seeder changes, re-seed with `npm run seed -- --seed=20260626` and re-label `eval/expectations/`.

### Decision log

`why.md` is append-only. Add a dated entry before finishing any non-trivial decision.
