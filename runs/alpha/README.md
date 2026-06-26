# Alpha run

_This is a placeholder._ Run `npm run alpha` to populate this directory.

Requires:

- `data/corpus.json` — produce it with `npm run seed -- --seed=20260626`.
- A warm Ollama serving the locked chat model (gemma4:26b takes minutes
  to load cold; pre-warm with
  `OLLAMA_KEEP_ALIVE=30m ollama run gemma4:26b ""`).

The first successful run overwrites this file with the index of captured
outputs (one row per brief in `eval/briefs/`).
