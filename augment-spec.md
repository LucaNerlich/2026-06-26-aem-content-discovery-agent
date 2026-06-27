## Locked Output Contract (canonical — every task references this)

Per the user's formal specification. This is the single source of truth for what the seeder produces and what the agent returns. Any task description that conflicts with this section is wrong — fix the task.

## Architecture (locked — JSON-primary, AEM-optional, sqlite-vec)

Per user direction (2026-06-26). Supersedes the earlier "live AEM only" narrative. The earlier sections under "Corpus strategy — AEM seeding + snapshot" and "Seeding mechanism — path γ" remain accurate as background, but the JSON-primary flow described here is the locked critical path.

### Repository layout (npm workspaces)

```
/
├── package.json                       (workspaces: [shared, content-seeder, discovery-agent])
├── shared/                            ← schemas, Ollama, embedder, BM25, sqlite-vec adapter, AEM client, fragment-source abstraction
│   └── src/{schema,llm,aem,retrieve,sources}/
├── content-seeder/                    ← Script 1: generates data/corpus.json, optionally pushes to AEM
│   └── src/seed.js
├── discovery-agent/                   ← Script 2: reads corpus, runs pipeline, emits AgentOutput
│   └── src/{cli.js, pipeline/, render/}
├── data/
│   └── corpus.json                    ← seeder's primary output, committed to the repo for grader reproducibility
├── eval/
│   ├── briefs/                        ← 5 hand-labeled briefs incl. winter-sustainable.txt
│   ├── expectations/                  ← per-brief JSON with expected matches + gaps
│   └── run.js
└── aemcontentdisc/                    ← pre-existing AEM project; Task 2 adds the CF Model XML into ui.content
```

### File-location map for tasks

- **shared/**: zod schemas (Task 3), Ollama client (Task 4), AEM HTTP client (Task 5), retrieval + sqlite-vec adapter + BM25 (Task 8), FragmentSource abstraction
- **content-seeder/**: seed script (Task 6)
- **discovery-agent/**: brief parser (Task 7), gap analyser (Task 9), composer (Task 10), CLI + Markdown renderer (Task 11)
- **eval/**: eval harness (Task 12)
- **root / aemcontentdisc/**: CF Model XML (Task 2)

### Data flow

```
seed.js (content-seeder)                    agent (discovery-agent)
  │                                            │
  │ gemma4:26b generates body                  │ reads brief.txt
  │ writes data/corpus.json ◀───────────────── │ FragmentSource.load()
  │                                            │   if --source=json (default): data/corpus.json
  │ (optional) --aem-push                      │   if --source=aem:           live from AEM
  │   POST each fragment via Sling/Assets API  │
  ▼                                            ▼
AEM @ localhost:4502 ◀── (optional) ────── --source=aem
```

### Vector store

- **Library**: `sqlite-vec` extension loaded into `better-sqlite3`
- **Storage**: `shared/.cache/embeddings.db` (gitignored)
- **Cache key**: `(fragment.id, fragment.lastModified, embeddingModel)` — re-embed only when the cache key changes, so warm runs cost zero embedding calls
- **Lexical**: `wink-bm25-text-search` (pure JS, in-memory, cheap to rebuild)
- **Why sqlite-vec**: real persistent vector store, SQL-queryable, zero-server. Demonstrates picking a right-sized tool. Interview signal note in README explains the choice.

### Ollama

- Default URL: `http://localhost:11434`
- Chat: `gemma4:26b` (JSON mode for structured stages)
- Embeddings: `embeddinggemma:300m` (768d, Matryoshka, multilingual)

### AEM (optional code paths)

- Host: `http://localhost:4502`
- Auth: HTTP Basic `admin:admin`
- Used by: `seed --aem-push` (Sling POST to `/content/dam/aemcontentdisc/<locale>/<id>`) and `agent --source=aem` (reads `.model.json` from same paths)
- Both paths are tested and documented but graders can run the full project without AEM by relying on the committed `data/corpus.json`.

### Critical-path vs optional matrix

| Capability | Path | Mandatory? |
| --- | --- | --- |
| Generate corpus | seeder → corpus.json | ✅ yes |
| Run agent end-to-end | corpus.json → AgentOutput | ✅ yes |
| Eval harness | runs against corpus.json | ✅ yes |
| CF Model XML | shipped in ui.content | optional but cheap, ships |
| AEM push | seeder --aem-push | optional, ships behind flag |
| AEM live read | agent --source=aem | optional, ships behind flag |

### Script 1: Content Fragment Seeder

**Purpose:** populate AEM with sample content fragments based on a pre-configured Content Fragment Model.

**Required parameters (CLI flags via **`mri`**):**

- `--model=<jcr-path>` — path to the deployed CF Model. Default: `/conf/aemcontentdisc/settings/dam/cfm/models/discovery-fragment`
- `--count=<n>` — number of fragments to generate per locale. Default: `8`. Range: `1..50`
- `--locales=<csv>` — subset of locales. Default: `en-gb,fr-fr,de-de`
- `--variation=<low|medium|high>` — controls LLM body diversity (temperature + prompt variety). Default: `medium`
- `--reset` — delete the existing fragment tree(s) under the targeted locales before seeding
- `--dry-run` — generate + log all fragments, perform zero AEM writes

**Behaviour:**

- Reads the CF Model definition from AEM (or fails loudly if absent) so the seeder validates that its output matches the model's field schema before writing
- Persists fragments under `/content/dam/aemcontentdisc/<locale>/<id>` with `cq:model` pointing at the model path
- Idempotent: re-running without `--reset` overwrites existing nodes by id, no duplicates
- Prints a structured summary at the end: `{ perLocaleCount, totalSeconds, avgBodyWords, model }`

### Script 2: Content Discovery Agent

**Input:** a plain-text content brief (file path argument or stdin).

**Output:** **exactly three blocks**, schema-validated, emitted as Markdown by default and as JSON with `--json`.

#### Output 1 — Top 3 Matching Content Fragments

**Exactly 3 entries** (or fewer only if the corpus contains fewer than 3 fragments matching all hard filters). Each entry contains:

- `id` — the fragment's slug (e.g. `frag_001`)
- `path` — the JCR path (e.g. `/content/dam/aemcontentdisc/en-gb/frag_001`)
- `score` — numeric, 0..1, the hybrid retrieval score
- `reason` — a **single-line** explanation of why this fragment matches the brief (≤140 chars)

#### Output 2 — Gap Analysis

A list of topics/sections mentioned in the brief that are NOT adequately covered by existing fragments. Each gap entry contains:

- `topic` — short label of what's missing (e.g. *"care instructions for merino-wool jumpers"*)
- `coverage` — **enum: **`"none"`** | **`"partial"`
  - `"none"` = no fragment in the corpus addresses this topic at all
  - `"partial"` = one or more fragments touch the topic but coverage is incomplete (wrong locale, missing brand voice, stale, too thin, etc.)
- `description` — one or two sentences explaining the gap (and for `partial`, what's missing relative to what exists)
- `partialMatches` — array of fragment `id`s that partially cover the topic (empty for `"none"`)
- `suggestedAction` — concrete next step for the author (e.g. *"Write a 200-word fr-fr care guide for merino blends, applying premium-tone and sustainability-voice"*)

#### Output 3 — Draft Outline

A suggested page structure for the brief. Top-level fields:

- `title` — proposed page title
- `pathHint` — proposed URL path (e.g. `/en-gb/collections/winter-sustainable`)
- `sections` — ordered array

Each `section` is **one of exactly two shapes**:

- **Reuse:** `{ heading, kind: "reuse", fragmentIds: [string, ...], rationale }` — cites one or more existing fragments to assemble this section from
- **New:** `{ heading, kind: "new", rationale, sourcingHint }` — marks the section as needing to be written from scratch; `sourcingHint` describes what the author should produce

No mixed shapes. Every section is explicitly one or the other so the assembly blueprint is unambiguous.

**Top-level **`AgentOutput`** shape:**

```
{
  schemaVersion: "1.0",
  brief: { audience, locale, tone, brandGuidelines[], requiredTopics[], pathHint },
  matchedFragments: [ {id, path, score, reason}, ... ],   // exactly 3
  gaps: [ {topic, coverage, description, partialMatches[], suggestedAction}, ... ],
  draftOutline: { title, pathHint, sections: [ ... ] }
}
```

### Changes vs the earlier draft of the plan

- **Top-k = 3** (was 5). Affects retrieval task.
- **Each match now also carries **`path` (was just `id`). Affects schema + composer + retrieval.
- **Gaps carry **`coverage: "none" | "partial"` (replaces the prior `kind: topic|locale|brandGuideline` taxonomy). The kind taxonomy is still useful internally for severity scoring but is no longer the user-visible field. Affects gap analyser + schema + composer.
- **Outline sections are strictly reuse-or-new, no mixed flag.** Affects composer + schema.
- **Seeder is fully parameterised** — `--model`, `--count`, `--variation`, plus the previously planned `--locales` / `--reset` / `--dry-run`. Affects seed task.

## Plan — Wave Structure

13 tasks across 5 waves. Tasks within a wave run in parallel; waves run sequentially. Each wave ends with a Verifier agent before the next wave starts. Estimated 12h total (3-4h over the brief's 8h target, accepted).

### Wave 1 — Foundation (3 parallel tasks)

1. Scaffold Node.js project structure
2. Define AEM Content Fragment Model in `ui.content/`
3. Canonical zod schemas (Fragment / StructuredBrief / AgentOutput)

### Wave 2 — I/O clients (2 parallel tasks)

1. Ollama wrappers (chat + embed) with retry, timeout, logging
2. AEM HTTP client (Sling POST for writes, Assets API for reads)

### Wave 3 — Seed the corpus (1 task, sequential — depends on Waves 1-2)

1. Seed script: gemma4-generated bodies + POST 24 fragments via Sling

### Wave 4 — Agent pipeline (4 parallel tasks — depend on Wave 3 verified)

1. Brief parser / rewriter (raw brief → StructuredBrief)
2. Hybrid retrieval (vector + BM25 + metadata filter + freshness)
3. Gap analyser (identifies missing topics / locales / brand combinations)
4. Composer (assembles the canonical AgentOutput + draft outline)

### Wave 5 — UX, evaluation, documentation (3 parallel tasks)

1. CLI entry + Markdown renderer + `--json` flag
2. Eval harness (5 labeled cases, precision@3 / recall@3 / gap-F1)
3. README + architecture doc + sample run + prompt-log

## Wave 1 — Foundation

- [ ] [Scaffold Node.js project structure](intent://local/task/b91df12a-da0c-44dd-b657-eddef86dcc2e)
- [ ] [Define AEM Content Fragment Model](intent://local/task/2a80db18-4a19-41cb-98fd-6824e98b6859)
- [ ] [Canonical zod schemas](intent://local/task/5514f731-8ace-4369-960f-68fcbd41f7ac)

## Wave 2 — I/O clients

- [ ] [Ollama client wrappers](intent://local/task/b6af12dd-723f-45ee-8faf-668e60bc8c78)
- [ ] [AEM HTTP client](intent://local/task/6ea5d0f8-af25-4a50-8392-4a173a019d11)

## Wave 3 — Seed the corpus

- [ ] [Seed script — gemma4 bodies + Sling POST](intent://local/task/a7657379-d1e1-4c7b-971a-3639c5d67107)

## Wave 4 — Agent pipeline

- [ ] [Brief parser / rewriter](intent://local/task/f69a2616-7bec-4989-8add-aa83899adebb)
- [ ] [Hybrid retrieval (vector + BM25 + filters + freshness)](intent://local/task/998e431d-26d2-4a77-aa4c-cac366c6fb0f)
- [ ] [Gap analyser](intent://local/task/51c793ac-7317-48df-9208-927720f8145f)
- [ ] [Composer — final structured output](intent://local/task/7a54c36e-db3c-4c39-b1b3-1504981a4929)

## Wave 5 — UX, evaluation, documentation

- [ ] [CLI + Markdown renderer](intent://local/task/740a6fac-74b6-4752-a61f-736f438fdfa3)
- [ ] [Eval harness](intent://local/task/8843edd4-06a7-4333-b0cf-eab5033b55d3)
- [ ] [README, architecture doc, sample run, prompt-log](intent://local/task/e9eef6c5-73fe-4bea-b633-bf98df301c5d)

# AEM Content Discovery Agent — First Draft

> Source: AEM_Content_Discovery_Agent_Brief.pdf (Adobe Customer Solutions, AI Engineer Exercise, 8h estimate).This is a first-draft spec for ideation. No tasks yet — we shape direction first, then split into waves.

## Goal (one sentence)

Build a command-line agent that, given a plain-text content brief, searches a synthetic AEM-style content corpus and returns: (1) top-3 reusable fragments with scores + reasons, (2) a gap analysis, and (3) a draft page outline that cites fragment IDs and marks new content.

## What the brief actually asks for

**Format:** Command-line tool — **Python or Node.js**. No web UI required.

**Three deliverables:**

1. **Synthetic content library** — 15–20 JSON fragments. Each fragment must have:
  - `id` (e.g. `frag_001`)
  - `title`
  - `category` (e.g. `product-story`, `care-guide`, `seasonal-campaign`)
  - `targetAudience`
  - `brandGuidelinesApplied` (e.g. `sustainability-voice`, `premium-tone`)
  - `locale` (e.g. `en-gb`, `fr-fr`, `de-de`)
  - `lastModified` (ISO date)
  - `content` — ≥100 words of realistic body text
2. **Runnable agent script** — single-command invocation, prints all three outputs for any brief.
3. **Architecture document** — one page, justifying 4 decisions:
  - **Embedding model** — why this one for this content?
  - **Chunking strategy** — how split, why?
  - **Retrieval method** — vector / keyword / hybrid? Why?
  - **Why agentic?** — which orchestration pattern and why?

**Example brief** (must be in README with actual output):

> "I'm writing a landing page for our new sustainable winter collection. Target audience is eco-conscious women aged 25–40 in the UK market. The page needs to cover: our recycled materials sourcing story, care instructions that extend garment life, and seasonal styling tips. Tone should match our premium brand voice. The page will sit under /en-gb/collections/winter-sustainable."

**Submission:** Public GitHub repo with code, prompt logs, corpus JSON, README (with sample output), architecture doc.

## What the agent must output (the three blocks)

The agent **always returns a single structured object** with exactly three result sections. Any human-readable rendering (Markdown, pretty-printed CLI) is a *view* over this object — never a parallel implementation.

### Canonical output schema

```jsonc
{
  "brief": {                            // echoed + the rewritten/structured form
    "raw": "string",
    "structured": {
      "audience": "string",
      "locale": "string",
      "tone": "string",
      "brandGuidelines": ["string"],
      "requiredTopics": ["string"],
      "pathHint": "string|null"
    }
  },

  "topMatches": [                       // §01 — exactly 3 (or fewer if corpus < 3)
    {
      "fragmentId": "frag_007",
      "title": "string",
      "score": 0.0,                     // 0..1, blended hybrid score
      "scoreBreakdown": {               // optional but encouraged for the architecture doc
        "semantic": 0.0,
        "lexical": 0.0,
        "metadata": 0.0,
        "freshness": 0.0
      },
      "reason": "one-line natural-language justification"
    }
  ],

  "gapAnalysis": {                      // §02
    "gaps": [
      {
        "topic": "string",              // one of structured.requiredTopics
        "reason": "why no fragment covers it (e.g. 'best match score 0.31 < 0.55 threshold')",
        "bestPartialMatch": {           // nullable — the closest fragment, if any
          "fragmentId": "frag_012",
          "score": 0.31
        }
      }
    ],
    "coveredTopics": ["string"]         // topics where retrieval cleared the threshold
  },

  "draftOutline": {                     // §03
    "title": "string",                  // suggested page title
    "path": "string",                   // suggested path (from pathHint or inferred)
    "sections": [
      {
        "heading": "string",
        "intent": "string",             // one-liner of what this section delivers
        "source": "reuse" | "new",      // ← REQUIRED on every section
        "fragmentIds": ["frag_007"],    // populated when source = "reuse"
        "notesForAuthor": "string|null" // populated when source = "new"
      }
    ]
  },

  "meta": {                             // observability — populated by the pipeline
    "model": "string",
    "embeddingModel": "string",
    "elapsedMs": 0,
    "pipelineSteps": [                  // step-by-step log; same shape as prompt-log
      { "step": "rewrite",   "elapsedMs": 0, "tokensIn": 0, "tokensOut": 0 },
      { "step": "retrieve",  "elapsedMs": 0, "topicCount": 0 },
      { "step": "gap",       "elapsedMs": 0 },
      { "step": "outline",   "elapsedMs": 0, "tokensIn": 0, "tokensOut": 0 }
    ]
  }
}
```

### Rules

- **Single source of truth.** The pipeline produces this object. The CLI renderer prints either:
  - JSON (`--json`, machine-readable, default for piping), or
  - Markdown rendered *from this exact object* (default for humans).
- **Every outline section has a **`source`** field** set to `"reuse"` or `"new"` — never omitted. `"reuse"` MUST cite at least one `fragmentId` from the corpus. `"new"` MUST include `notesForAuthor`.
- `topMatches`** length ≤ 3.** Empty array is valid (corpus mismatch); the README sample run must still produce 3.
- `gapAnalysis.gaps`** MAY be empty** — output is still valid; that's the "full coverage" case.
- **Schema is versioned.** Add `"schemaVersion": "1.0"` at the top level so the architecture doc can talk about evolution.
- **Validation.** A JSON Schema (or pydantic/zod model) validates the object before it leaves the agent. If the LLM step returns something off-shape, the agent retries once, then fails loud with the schema violation in stderr.

## Pipeline architecture (per user direction)

The agent runs as an **explicit multi-step pipeline**, not a single RAG call:

```
[1] Incoming brief (raw user text)
        │
        ▼
[2] LLM rewrite / structuring step
    - normalises and clarifies the brief
    - extracts requirements as structured data:
        { audience, locale, tone, brandGuidelines[], requiredTopics[], pathHint }
    - (optional) expands each topic with synonyms / paraphrases
    - (optional) generates a hypothetical "ideal fragment" per topic (HyDE)
        │
        ▼
[3] Retrieval (RAG)
    - one query per requiredTopic (multi-query)
    - hybrid: vector + BM25 + metadata filter (locale, brandGuidelines)
    - dedupe + score-blend across topics → corpus-wide top-N
        │
        ▼
[4] Coverage / gap analysis
    - per topic: is the best-matching fragment above threshold?
    - topics below threshold → gaps
        │
        ▼
[5] Compose final outputs into the **canonical structured object** (see schema below)
    - topMatches[]    — Top-3 fragments with score + LLM-generated one-line reason
    - gapAnalysis     — gaps[] from step 4 + coveredTopics[]
    - draftOutline    — LLM, conditioned on retrieved fragments + gaps; every section.source ∈ {"reuse","new"}; reuse cites fragmentIds, new carries notesForAuthor
        │
        ▼
[6] Schema-validate, then render
    - default: Markdown to stdout (rendered from the object)
    - --json: emit the raw object
    - validation failure → retry once → fail loud with schema diff on stderr
```

**Why this shape:**

- Step [2] is the lever that lets a vague human brief become high-recall retrieval input. Without it, "premium winter sustainable" returns roughly what `tf-idf` would.
- The structured output of [2] is *reused* in [4] (gap analysis already has the topic list) and [5] (outline knows the required sections). One LLM call, three downstream consumers.
- The pipeline is **inspectable** — each step's input/output can be logged → answers "why agentic, not a black-box prompt" cleanly in the architecture doc.

### New sub-decisions this introduces

- **2a. Rewrite output shape** — structured JSON (recommended, reusable downstream), free-text expansion, or both?
- **2b. Multi-query vs single-query** — do we retrieve once per `requiredTopic`, or one merged query?Recommended: **per-topic**, because it also gives us per-topic gap signal for free.
- **2c. HyDE?** — generate a hypothetical fragment per topic and embed *that* for vector search. Often improves recall on short, abstract briefs. Adds 1 LLM call per topic. Worth it for the demo?
- **2d. Clarification loop** — if the brief is ambiguous, should step [2] ask back, or always proceed with best-guess + a "uncertain about X" note in the output? For a non-interactive CLI, "proceed + note" is the safer default.
- **2e. Caching** — cache the rewrite step output keyed by brief hash, so re-runs during demo are instant?

## Corpus strategy — AEM seeding + snapshot (new direction)

**You asked for:** a seeding script that uses "AEM API or MCP" + `@faker-js/faker` to create `N` content fragments per locale in the local AEM author.

### What the linked Adobe docs actually expose (correction)

I checked both pages you referenced:

- The **AEM Quickstart Local MCP server** (the content package you install into the local SDK at `/crx/packmgr`) only exposes **three diagnostic tools**: `aem-logs`, `diagnose-osgi-bundle`, `recent-requests`. **It does NOT expose Content Fragment CRUD.** It's a debugging surface for developers, not a content authoring surface.
- The **Cloud Service Content MCP server** (at `https://mcp.adobeaemcloud.com/adobe/mcp/content`) **does** expose CF CRUD: `list_models`, `get_model`, `create_fragment`, `get_fragment`, `patch_fragment`. But it talks to a **Cloud Service instance**, not the local SDK Quickstart, and requires Adobe ID OAuth.

**Implication:** there is no "MCP-to-local-AEM" path for creating Content Fragments today. To seed CFs into the local SDK we use the **AEM HTTP/Sling API** directly:

- Sling POST servlet to create CF nodes under `/content/dam/`, OR
- AEM Assets HTTP API (`POST /api/assets/<path>` with multipart) for fragment creation, OR
- A small custom Sling servlet we ship in the AEM project to wrap CF creation cleanly.

We can still **mention MCP in the architecture doc** as the natural production path ("in Cloud Service this would be a 2-line `create_fragment` call against the Content MCP server") — that signals AEM depth without the implementation cost.

### What this also resolves

This direction **resolves Q3 (the existing AEM project)** in favour of **"wire it in"**. We need:

- A **Content Fragment Model** (XML/JSON) in `ui.content` mirroring our schema: title, category, targetAudience, brandGuidelinesApplied[], locale, lastModified, content.
- Folder structure under `/content/dam/aemcontentdisc/<locale>/` per locale.
- A seeding Node script (`scripts/seed.js`) calling the local AEM author.

### Three strategies for how the agent consumes the corpus

| Strategy | Reviewer experience | Effort | Interview signal |
| --- | --- | --- | --- |
| A. Seed AEM → export JSON snapshot → agent reads JSON | Reviewer runs the agent with no AEM required | Low–medium | Shows AEM depth via the seed step; agent stays portable |
| B. Seed AEM → agent reads AEM live (Sling/GraphQL at runtime) | Reviewer must run local AEM (SDK install, 30 min+) | High | Maximum AEM signal, fragile for the reviewer |
| C. Hybrid: snapshot by default, --source=aem flag for live mode | Same as A by default, B on opt-in | Medium–high | Best of both, modest extra code |

**My strong recommendation: Strategy A** (or C if you want the demo to flex live AEM in the interview call).Reason: the brief explicitly says "Time estimate 8 hours" and "agent must run with a single command." If the reviewer can't run the agent without spinning up the AEM SDK, you've violated both. Strategy A keeps the agent reviewer-safe; the AEM project becomes a *companion deliverable* that demonstrates "I can also do AEM."

### Body content generation — three options

`faker` is great for *structural* fields (titles, names, dates, locales, taxonomy picks) but generates lorem-ipsum-ish prose for body text, which will tank embedding quality. Options:

1. **Faker + templated paragraphs** — write 5–10 paragraph "skeletons" per category with `{{faker.commerce.productMaterial}}`-style holes. Cheap, readable, on-brand. Recommended.
2. **Faker structure + Ollama-generated body** — call `gemma4:26b` once per fragment to write the body, seeded with the structural fields. Realistic but slow seeding (~30s × `N` fragments × locales) and outputs vary per run.
3. **Pre-written body bank** — author 30–60 paragraphs by hand, faker picks one per fragment. Highest quality, most up-front time.

Recommended default: **option 1**, with option 2 mentioned in README as `npm run seed -- --bodies=llm`.

### Corpus shape (proposed)

- Locales: `en-gb`, `fr-fr`, `de-de` — matches the PDF brief's `/en-gb/` example and lets us demo locale filtering across two non-English locales.
- `N` per locale: **6–8** → 18–24 fragments total, within the brief's "15–20" target. (Or scale to 10/locale = 30 for a bigger corpus.)
- Categories: `product-story`, `care-guide`, `seasonal-campaign`, `brand-values`, `size-guide`, `material-spotlight`.
- Brand guidelines: `sustainability-voice`, `premium-tone`, `inclusive-language`, `technical-precision`.
- **Deliberate gap planted in en-gb**: zero fragments tagged with `winter-styling` or covering "seasonal styling tips" → the example brief's gap analysis has something honest to report.
- Locale-aware brand vocabulary: same brand-guideline *tags*, but body templates use locale-appropriate phrasing (en-gb spelling, fr-fr translations).

### Seeding script shape

```
scripts/seed.js
  --target=aem|json|both        # where to write (default: both)
  --locales=en-gb,fr-fr,de-de   # which locales to populate
  --per-locale=8                # how many per locale
  --bodies=template|llm         # body generator strategy
  --reset                       # delete existing fragments under our DAM folder first
  --base-url=http://localhost:4502
  --credentials=admin:admin     # local SDK default
```

Outputs:

- AEM: real Content Fragments under `/content/dam/aemcontentdisc/<locale>/`
- JSON: `corpus/fragments.json` — what the agent reads by default

### Scope estimate (C1–C6 fully locked, path γ)

| Task | Estimate |
| --- | --- |
| Define CF Model in ui.content (XML node defs, package + install) | 1.5h |
| Seeding script: faker (structural) + Ollama body generation + Sling POST | 2.0h |
| Seed runtime ≈ 24 × ~20–30s body generation = ~10 min (acceptable) | – |
| AEM live-read in agent (Assets / Sling GraphQL query + parse) | 1.5h |
| Agent pipeline (rewrite + retrieve + gap + compose + render) | 3.0h |
| zod schemas + Ollama wrappers + CLI + tests | 1.5h |
| Corpus tuning + README + architecture doc + sample run | 1.5h |
| Eval harness (small, optional) | 1.0h |

| Total | Without eval | With eval |
| --- | --- | --- |
| Path γ | ~11.0h | ~12.0h |

User accepted over-budget. ~3–4h over the 8h target — defensible at interview as "I prioritised AEM integration + multi-locale corpus over staying under budget; here's what I'd cut if I had to."

### Questions this raises

- **C1.** Strategy A, B, or C for how the agent consumes the corpus?
- **C2.** Body generation: option 1 (templates), option 2 (Ollama), or option 3 (hand-written)?
- **C3.** `N` per locale (suggest 6–8)?
- **C4.** Locales: `en-gb` + `fr-fr` + `de-de` (resolved).
- **C5.** Acceptable to go over 8h budget? (Honest answer: a sharp interview reviewer respects "I cut feature X to stay on budget" more than "I went over.")
- **C6.** Do we ship the CF Model XML *and* a working AEM build, or just the seed script + JSON?

## Implicit signals worth interpreting

- "Brand voice" / "brandGuidelinesApplied" → matching is not purely semantic; it's also a **constraint check** (does a fragment match `premium-tone` AND `sustainability-voice`?).
- "Locale" → the example brief is `en-gb`. Locale filtering is expected; cross-locale fallback is a decision to make.
- "lastModified" → freshness probably feeds into the score (recent > stale).
- "40,000+ pieces" in the background → architecture should *talk* like it could scale, even if the demo uses 20.
- "Gap analysis" needs the agent to **decompose the brief into required topics** first, then check coverage against fragments. This is the part that genuinely needs an LLM.
- "Cites fragment IDs" in the outline → the LLM must be prompted to anchor every section to a fragment ID or explicitly flag it as new.

## Key decisions to make in the ideation session

### 1. Language: Node.js 22 (locked)

Implications now that we're committed:

- **Module system:** ESM (`"type": "module"` in package.json). Cleaner imports, plays well with Node 22.
- **CLI parsing:** `util.parseArgs` (built into Node 22, zero-dep) → lean toward this. `commander` if we outgrow it.
- **Schema validation:** `zod` — runtime validation + TS-style inferred types in one definition. Used for both LLM-output validation and the canonical output schema.
- **Ollama client:** `ollama` npm package (official) for chat + embed.
- **Vector search:** at 20 docs, **brute-force cosine** in pure JS is fastest and dependency-free. At the 40k-doc hypothetical scale, swap to `hnswlib-node` or `lancedb`. Mention the swap path in the architecture doc.
- **BM25 / lexical:** `minisearch` (tiny, in-memory).
- **Testing:** `node --test` + `node:assert` (built-in, no Jest/Vitest).
- **Prompt templating:** raw template literals → easier to log verbatim.

Accepted trade-offs:

- LangChain.js is less mature than LangChain Python → we sidestep it entirely. Hand-rolling the small pipeline is *more* defensible at interview ("I controlled every step rather than hiding it behind a framework").
- Fewer off-the-shelf RAG primitives → at this scale, that's a feature.

### 2. LLM provider: Ollama `gemma4:26b` (pending tag verification)

⚠️ **Action item:** confirm the exact Ollama tag. As of today the official library has `gemma3:27b` (17 GB) and `gemma2:27b` (16 GB); I couldn't find `gemma4:26b`. Options:

- You meant `gemma3:27b` (most likely)?
- Custom / community build?
- A new release I should re-check on ollama.com/library?

Implications regardless of exact tag:

- ~16–18 GB on disk, ~24–32 GB RAM at runtime → fits your 64 GB box, but a reviewer on a 16 GB laptop cannot run it.
- Need a **smaller-model fallback** via `OLLAMA_MODEL` env var (e.g. `gemma3:4b` / `llama3.1:8b`) so a reviewer can smoke-test.
- README must state hardware requirements + the fallback override.
- Optional **hosted fallback** (OpenAI / Anthropic / Gemini) behind an env var → one-line escape hatch for reviewer. Not primary.
- All LLM calls should set temperature ≈ 0 for output stability (and so the README sample output matches reality).

### 3. Embedding model — `embeddinggemma:300m` (locked)

Google's EmbeddingGemma (released late 2025) via Ollama.

| Property | Value |
| --- | --- |
| Parameters | 300M |
| Default output dim | 768 |
| Matryoshka dims supported | 768 / 512 / 256 / 128 (truncate without re-embedding) |
| Multilingual coverage | 100+ languages — covers en-gb, fr-fr, de-de natively |
| Context window | 2048 tokens (fragments are well under) |
| RAM footprint | ~600 MB — trivial alongside gemma4:26b |
| MTEB-multilingual | Top-tier among <500M models at release |

**Why this is the right call:**

- **Multilingual** out of the box → no per-locale embedding strategy needed for en-gb / fr-fr / de-de, and cross-locale retrieval (e.g. relaxing a fr-fr query to de-de) "just works" semantically if we ever need it.
- **Tiny** at 300M → seeding 24 fragments takes seconds, not minutes; query-time latency is irrelevant.
- **Matryoshka** is a nice talking point in the architecture doc: "embedded at 768d, can truncate to 256d at retrieval time for 3× memory savings at 40k-doc scale" — answers the "would this scale?" question for free.
- **Same model family as the LLM** (`gemma4` / Gemma) → clean narrative: "Gemma family for both embedding and generation — single research lineage, single licence, single tokeniser pedigree to reason about."

**Architecture-doc paragraph (draft):**

> EmbeddingGemma 300M was chosen for three reasons. First, the corpus is multilingual (en-gb, fr-fr, de-de) and EmbeddingGemma is trained on 100+ languages, removing the need for per-locale embedding indices. Second, at 300M parameters it runs locally alongside the generation model with no measurable resource pressure. Third, its Matryoshka representation supports later dimension truncation (768→256), giving a credible scale-up path to the brief's 40 000-fragment scenario without re-indexing.

### 4. Chunking strategy

- Fragments are ~100–300 words. Options:
  - **Whole-fragment embeddings** (simple, defensible at this corpus size).
  - **Sub-chunk by paragraph** with parent-doc retrieval (more realistic at 40k scale).
- For 20 fragments, whole-fragment is fine *if we justify it as scale-appropriate* and mention the scale-up path.

### 5. Retrieval method

- **Vector-only** — clean, but misses exact-match signals (locale codes, brand-guideline tags).
- **Keyword (BM25) only** — fast but misses paraphrasing.
- **Hybrid (vector + BM25, with metadata filters)** — best fit for the brief because it has both fuzzy ("sustainability story") and exact ("en-gb", "premium-tone") signals.
- *Recommendation:* **hybrid + metadata filter on locale/brand**.

### 6. Agentic pattern

- Three plausible patterns:
  - **A. Fixed multi-step pipeline** with LLM-powered steps (rewrite → retrieve → gap → outline). Deterministic graph, LLM inside the nodes. → **This is what we've now agreed on.**
  - **B. Plan-and-execute** — LLM picks the order from a tool set.
  - **C. ReAct loop** — multi-turn reasoning.
- Decision: go with **(A) fixed multi-step pipeline**, because:
  - The brief's three required outputs map 1:1 to pipeline stages → easy to evaluate.
  - Each LLM call has a tight, testable contract → reviewable in the architecture doc.
  - Still defensible as "agentic" because (i) the rewrite step is autonomous reasoning over an open-ended input, (ii) the pipeline can branch (gap-driven re-retrieval, locale fallback), (iii) the outline step grounds itself in *tool-retrieved* evidence rather than parametric memory.
- We may add **one ReAct-style escape hatch**: if step [4] finds a gap, the agent may retry retrieval with a relaxed locale filter before declaring it a gap. Mention in architecture doc as "bounded autonomy".

### 7. Scoring & "reason for match"

- Score = weighted blend (semantic + BM25 + metadata bonus). Reason = LLM-generated one-liner per result, grounded in the brief + fragment.

### 8. Gap analysis approach

- Extract required topics from the brief (LLM, structured output) → for each topic, run retrieval → if top score < threshold, mark as gap.

## Decisions locked in so far

- **Language:** Node.js, target Node 22 (ESM, native fetch, native test runner).
- **LLM:** `gemma4:26b` via Ollama (verified — official `ollama.com/library/gemma4:26b`). Google DeepMind Gemma 4 26B A4B (Mixture-of-Experts, ~3.8B active / 25.2B total), 18 GB on disk, 256K context, text+image. Released ~Apr 2026. Benchmarks: MMLU Pro 82.6%, AIME 2026 88.3%, GPQA Diamond 82.3%, LiveCodeBench v6 77.1%, MMMLU 86.3% (multilingual). Native function-calling + configurable thinking mode. Recommended sampling: `temperature=1.0`, `top_p=0.95`, `top_k=64`. Pulled via `ollama pull gemma4:26b`.
- **Embedding model:** `embeddinggemma:300m` via Ollama. Multilingual (100+ langs, covers our 3 locales), 300M params, 768d default with Matryoshka truncation, ~600 MB RAM. Pairs with `gemma4` family for a clean narrative.
- **Agent pattern:** fixed multi-step pipeline (rewrite → retrieve → gap → compose) with one bounded escape hatch (locale-relaxed re-retrieval on gap).
- **Output:** single canonical structured object, schema-validated, with Markdown renderer + `--json` flag.
- **AEM project:** wired in. Ships CF Model XML + working build.
- **Corpus consumption (C1):** **Strategy B — agent reads AEM live at runtime.** No snapshot file consumed by the agent. (Snapshot may still be written by the seeder as a debugging artefact.)
- **Body generation (C2):** Ollama `gemma4:26b` writes each fragment body. Seeding will take ~3–12 min depending on model latency; acceptable as a one-time setup step.
- **Fragments per locale (C3):** **8**.
- **Locales (C4):** `en-gb`, `fr-fr`, `de-de` → 24 fragments total. Matches the PDF brief's `/en-gb/collections/winter-sustainable` example exactly — no locale-relaxation needed.
- **Time budget (C5):** over 8h is acceptable.
- **AEM seeding mechanism (C6):** ship CF Model XML + seed fragments via **AEM HTTP / Sling API directly** (path γ). MCP is *not* used for seeding — neither the local SDK MCP (lacks CF tools) nor the Cloud Service MCP (no Cloud Service instance available). MCP gets one paragraph in the architecture doc as "the natural production-path equivalent (Adobe's Cloud Service Content MCP exposes `create_fragment` / `patch_fragment` for this exact workflow)".

## Fragment Schema (locked — single source of truth)

These are the **required** properties on every Content Fragment in the corpus (per the PDF brief). The CF Model XML in `aemcontentdisc/ui.content/` must define each as listed; the seeder must populate each; the agent's typed view (zod schema) of an AEM fragment must mirror this exactly.

| Field | Type | AEM CF Model element | Required | Constraints / examples |
| --- | --- | --- | --- | --- |
| id | string | text-single | yes | Stable unique slug, e.g. frag_001. Used as the JCR node name and as the foreign key in agent output. |
| title | string | text-single | yes | Human-readable page/component title. |
| category | enum string | text-single with allowed values | yes | One of: product-story, care-guide, seasonal-campaign. Extendable in the model. |
| targetAudience | string | text-single (multiline) | yes | Short demographic description, e.g. "Eco-conscious women aged 25–40, UK market." |
| brandGuidelinesApplied | string[] | text-multi (or tag picker) | yes | Multi-value. Examples: sustainability-voice, premium-tone, inclusive-language. |
| locale | enum string | text-single with allowed values | yes | One of the corpus locales: en-gb, fr-fr, de-de. |
| lastModified | ISO datetime | date-time | yes | Full ISO 8601 (e.g. 2026-04-12T09:30:00Z). Agent uses for freshness scoring. |
| content | string (long) | text-multi (rich text or plain) | yes | ≥100 words of realistic body text. Generated by gemma4:26b at seed time, locale-appropriate. |

### Implementation notes for the seeder

- `id` is also the CF node name → idempotent re-seeds overwrite the same node.
- `brandGuidelinesApplied` should produce **realistic combinations**, not single-value uniform tags — e.g. one fragment carries `["sustainability-voice", "inclusive-language"]`, another carries `["premium-tone"]`. Diversity here makes the brand-rule constraint check meaningful.
- `category` distribution per locale should be roughly even (≈ 2-3-3 across the three categories, varied per locale) so retrieval can't trivially shortcut to a single category.
- `lastModified` should span a realistic recency window (e.g. last 18 months) so the freshness signal has signal.
- `content` ≥100 words is the floor — aim for ~150-250 words so chunking has something to bite on.

### Implementation notes for the agent

- The agent's internal `Fragment` zod schema mirrors this 1:1 (no extra agent-only fields).
- `brandGuidelinesApplied` is treated as a **constraint filter** post-retrieval (intersection-must-be-non-empty against the brief's required brand guidelines), not as embedding signal.
- `locale` is a hard pre-filter on retrieval; relaxation (see "robustness" notes) is an explicit, logged step.
- `lastModified` feeds a small freshness multiplier on the final score (decay over ~18 months).

## Seeding mechanism — path γ (Sling/Assets HTTP API)

Resolved: **MCP cannot create Content Fragments against the local SDK** (the local Quickstart MCP only exposes diagnostic tools; Cloud Service MCP requires a Cloud Service instance). The seeder uses the AEM HTTP API directly.

### Concrete approach

- Authenticate with the local SDK default `admin:admin` (Basic auth).
- Create the CF Model once via package install (`mvn install -PautoInstallSinglePackage` builds `ui.content` and pushes the model XML).
- Per fragment: `POST` to `/api/assets/aemcontentdisc/<locale>/<slug>` with the CF `cq:model` reference and JSON body for each field.
  - If the JSON-API path proves finicky for CFs, fall back to a Sling POST against `/content/dam/aemcontentdisc/<locale>/` with `jcr:primaryType=dam:Asset` and the CF metadata properties directly. Both paths are documented in AEM and work against the local SDK.
- Idempotent: `--reset` flag deletes `/content/dam/aemcontentdisc/` before seeding.

### What this means for the architecture doc

One short paragraph titled "Production path: MCP" — call out that on Cloud Service, `mcp.adobeaemcloud.com/adobe/mcp/content` exposes `create_fragment` / `patch_fragment` / `get_fragment` and the same seed script would shrink to a generic MCP client. Demonstrates awareness without the implementation cost.

## Open questions for the user

1. **Rewrite step details** — see new sub-questions 2a–2e under "Pipeline architecture". Quickest answer: structured JSON output, per-topic multi-query, no HyDE for v1, no clarification loop, cache enabled.
2. **Language preference** → **Node.js (Node 22)**.
3. **LLM**: locked to Ollama `gemma4:26b` (pending tag verification — see §2 above). Need: confirmation of exact tag + agreement on env-var fallback model for low-RAM reviewers.
4. **The existing AEM project** — partially resolved: per the seeding-script direction, the AEM project is now **wired in** as the seed target. Open sub-questions moved to **§C1–C6 under "Corpus strategy"**.
5. **Corpus realism** — generate the 20 fragments by hand (slower, higher quality) or have an LLM author them once and commit (faster, must check for hallucinated brand claims)?
6. **Evaluation** — do you want a tiny eval harness (a few hand-graded briefs → expected fragment IDs) to defend retrieval choices in the architecture doc? Strong signal at interview, ~1h of work.
7. **Output format** — resolved: canonical output is the structured object above. CLI renders Markdown by default, `--json` emits the raw object. Schema-validated before emit.
8. **Prompt logs** — the brief says "prompt logs" must be submitted. Capture as JSONL written by the agent on each run, or maintain a curated `PROMPTS.md`? Probably both: curated final prompts + raw run log.

## Non-goals (proposed)

- No web UI.
- No real AEM integration — now in scope as the **seeding target** (write path only; runtime read path TBD per §C1).
- No production AEM deployment / no Cloud Manager pipeline.
- No real Cloud Service MCP integration (mentioned in architecture doc as the production-path equivalent).
- No fine-tuning.
- No production-grade vector DB — brute-force cosine in pure JS is fine for ~30 docs.
- No multi-user, no auth, no API server.

## Tentative shape of the final repo (Node 22, ESM)

```
package.json                    # type=module, node>=22
                                # bin: { agent: "./src/cli.js", seed: "./scripts/seed.js" }
src/
  cli.js                        # arg parsing (util.parseArgs), renders output, exit codes
  pipeline.js                   # orchestrates the 4 steps
  steps/
    rewrite.js                  # LLM call → structured brief (zod-validated)
    retrieve.js                 # hybrid: cosine + BM25 + metadata filter
    gap.js                      # threshold check per topic, locale-relaxed retry
    compose.js                  # LLM call → topMatches reasons + outline (zod-validated)
  llm/
    ollama.js                   # chat + embed wrappers, retries, prompt logging
    schema.js                   # zod schemas: brief, structuredBrief, output object
  render/
    markdown.js                 # object → human-readable Markdown
  corpus/
    load.js                     # read + validate fragments.json (or read live AEM)
    aem-client.js               # (if strategy C) Sling/GraphQL reader
scripts/
  seed.js                       # the new seeding CLI
  seed/
    faker-templates.js          # locale × category templated body skeletons
    aem-writer.js               # POSTs to local Sling/Assets API
    body-llm.js                 # optional Ollama-based body generator
prompts/
  rewrite.system.md
  compose-reasons.system.md
  compose-outline.system.md
corpus/
  fragments.json                # snapshot produced by the seed script
aemcontentdisc/                 # existing AEM project (now wired in)
  ui.content/...                # add CF Model XML for our fragment schema
eval/
  briefs/*.txt
  expected/*.json
  run.js                        # precision/recall report
logs/                           # gitignored, JSONL prompt logs per run
README.md
ARCHITECTURE.md
PROMPTS.md
```

## Still to plan (we're not blocked — keep throwing notes)

Open planning topics we haven't touched yet:

- **Corpus design** — 20 fragments must cover most of the example brief AND leave at least one realistic gap so the gap-analysis section has something to show. Build a matrix: categories × locales × brand guidelines, with a **deliberate gap** (e.g. lots of "recycled materials" and "premium tone" content, but **no** "winter styling tips") so the example output looks honest.
- **Determinism & demo reproducibility** — temperature 0 + low top-p. README sample output kept in sync via an `npm run record-golden` script that overwrites a checked-in fixture.
- **Prompt design** — locked artefacts: (a) brief-rewrite system prompt, (b) match-reason generator prompt, (c) outline composer prompt. Versioned under `prompts/`, all loaded at runtime + hash logged.
- **Prompt logging format** — JSONL per run: `{ runId, ts, step, model, promptHash, prompt, response, elapsedMs, tokensIn, tokensOut }`. Curated highlights copied to `PROMPTS.md` for the submission.
- **Eval harness** — small set of hand-graded briefs → expected `fragmentId`s + expected gap topics. Powers a single command that prints precision@3, recall@3, and gap-detection F1. Strong interview signal, ~1h.
- **Failure modes** — Ollama not running, model not pulled, embedding dim mismatch on corpus reload, LLM returns invalid JSON, corpus malformed. Each gets a clear error and exit code (`1` = user error, `2` = LLM contract failure, `3` = corpus/env failure).
- **README structure** — install → `ollama pull` → one-line run → sample output for the PDF brief → hardware requirements → fallback model env var → architecture-doc link.

## Verification plan (sketch)

- `npm run seed -- --target=both` populates AEM and writes `corpus/fragments.json`. Re-run is idempotent (`--reset`).
- AEM Package Manager / CRX shows the CF Model installed + fragments under `/content/dam/aemcontentdisc/<locale>/`.
- `node src/cli.js "$(cat eval/briefs/winter-sustainable.txt)"` produces a schema-valid structured object with all three sections populated.
- `--json` flag emits the raw object; default mode emits Markdown rendered from the same object.
- Sample output for the PDF brief appears verbatim in README and matches the recorded golden fixture.
- README "Setup" works on a clean clone in <5 min (excluding model download AND **excluding AEM SDK install** if we go with Strategy A).
- Architecture doc fits on ~one screen of Markdown, answers all four required questions, **and mentions the AEM seed + Cloud Service MCP path**.
- Optional: `npm run eval` prints precision@3 / recall@3 / gap F1 over the hand-graded briefs.

## What I need from you to unblock task breakdown

Not blocked yet — keep ideating. When you're ready to split into implementor waves, the minimum I need is:

1. **Confirm or correct the Ollama LLM tag** (`gemma4:26b` vs `gemma3:27b` vs something else).
2. **Embedding model pick** — or default to `nomic-embed-text` + English-only corpus.
3. **AEM project decision** — drop / dormant / wire in. (Reminder: the brief does not ask for it.)
4. **Yes/no on each of 2a–2e** (rewrite shape, multi-query, HyDE, clarification loop, cache).
5. **Eval harness** — include it or skip?
6. **Corpus authoring** — hand-write, LLM-generate-then-curate, or hybrid?

--- Task Metadata ---Status: not_started