# Eval harness

Offline evaluator for the AEM Content Discovery Agent. Runs the full pipeline
(`parseBrief → retrieve → analyseGaps → compose`) against the committed
`data/corpus.json` for 5 hand-labeled briefs and prints retrieval
**precision@3 / recall@3** plus a semantic **gap-F1**.

```
npm run eval
```

Writes a structured run report to `eval/latest.json` and exits non-zero when
the aggregate gap-F1 falls below `EVAL_F1_THRESHOLD` (default `0.6`).

## Reproducibility lock

Expectations reference deterministic fragment ids (`frag_001`, `frag_002`, …)
that only stay stable when the seeder uses the locked seed.

- **`DEMO_SEED = 20260626`** — top-level constant in `eval/run.js`.
- If you change the seeder, rerun:

  ```
  npm run seed -- --seed=20260626
  ```

  and re-hand-label the expectations files in `eval/expectations/` against
  the new snapshot. Commit `data/corpus.json`, `data/embeddings.db`, and
  the updated briefs/expectations together.

## Layout

```
eval/
├── briefs/                       hand-written briefs (one .txt per brief)
│   ├── winter-sustainable.txt    spec example (verbatim) — en-gb
│   ├── fr-fr-knitwear.txt        rich fr-fr brief (locale relaxes to "any")
│   ├── de-de-berlin-street.txt   de-de brief with a topic absent from corpus
│   ├── en-gb-technical-outerwear.txt  forces a brand-guideline gap
│   └── en-us-holiday-gifting.txt  en-us prefix locale relaxation (override)
├── expectations/                 one .json per brief, same basename
│   └── { localeOverride?, expectedMatchIds[], expectedGaps[] }
├── run.js                        evaluator (entry point for npm run eval)
└── latest.json                   produced on every run; safe to commit
```

## Metric definitions

- **precision@3 / recall@3** — set intersection of returned
  `matchedFragments[].id` with `expectedMatchIds`. Order-insensitive.
- **gap-F1** — for every expected gap, greedy-match the best returned gap
  with the same `coverage` enum and a topic-label cosine similarity ≥ 0.7.
  Cosine uses `embeddinggemma:300m` so paraphrases are not penalised.
- **aggregate** — unweighted mean of per-brief metrics over the 5 briefs.

Briefs in `eval/briefs/` without a matching `eval/expectations/` file are skipped (with a `warn:` line on stderr) rather than aborting the run — additional alpha-runner briefs live alongside the eval set, but un-calibrated expectations would skew aggregate metrics.

## Per-brief scenarios

| Brief | Locale (effective) | Why it's here |
|---|---|---|
| `winter-sustainable` | en-gb (exact) | Spec example verbatim. |
| `fr-fr-knitwear` | fr-fr → any | Locale relaxation; brand combination filters dropouts. |
| `de-de-berlin-street` | de-de → any | Forces `coverage: "none"` on a topic with no fragment. |
| `en-gb-technical-outerwear` | en-gb | Forces a `coverage: "partial"` brand-guideline gap (`technical-precision` is absent from the corpus). |
| `en-us-holiday-gifting` | en-us → en-gb (prefix) | Locale prefix relaxation via `localeOverride`. |

`localeOverride` is the only optional knob in the expectations JSON — used
when a brief targets a locale outside the parser's `en-gb | fr-fr | de-de`
allowed list, so the evaluator can still exercise that code path.

## Tuning

| Env var | Default | Effect |
|---|---|---|
| `EVAL_F1_THRESHOLD` | `0.6` | Exit non-zero if aggregate gap-F1 falls below this. |
| `EVAL_CHAT_MODEL` | `gemma4:26b` | Override the chat model used by the harness only (the agent's runtime default is untouched). Useful on hardware where the default model is impractically slow. |
| `LOG_LEVEL` | `error` | Pipeline pino logger verbosity. |
| `OLLAMA_HOST` | `http://localhost:11434` | Inherited from `@aemdisc/shared`. |

### Model variance

Expectations are calibrated against `gemma4:26b` — the model the agent's
runtime uses. Smaller chat models will fluctuate on:

- whether a topic verdict comes back as `partial` vs `none`,
- the exact wording the LLM returns for each `topic` (semantic match still
  passes if cosine ≥ 0.7),
- and whether `parseBrief` correctly extracts every brand guideline.

A typical run with `gemma4:26b` clears the 0.6 threshold; runs with a
fallback like `EVAL_CHAT_MODEL=qwen2.5-coder:1.5b` may dip below it and exit
non-zero. Either way `eval/latest.json` records exactly what was returned so
the discrepancy is auditable.
