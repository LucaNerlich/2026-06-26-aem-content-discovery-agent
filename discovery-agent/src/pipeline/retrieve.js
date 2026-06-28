import {
  embed,
  openVectorStore,
  buildBm25Index,
  AemFragmentSource,
} from "@aemdisc/shared";

const TOP_PER_QUERY = 15;
const FRESHNESS_MONTHS = 18;
const WEIGHTS = { cosine: 0.6, bm25: 0.3, freshness: 0.1 };
const MS_PER_MONTH = 1000 * 60 * 60 * 24 * (365.25 / 12);

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function freshnessScore(lastModified, now = Date.now()) {
  if (!lastModified) return 0;
  const t = Date.parse(lastModified);
  if (Number.isNaN(t)) return 0;
  const months = (now - t) / MS_PER_MONTH;
  return clamp01(1 - months / FRESHNESS_MONTHS);
}

function applyLocaleLadder(fragments, briefLocale) {
  const exact = fragments.filter((f) => f.locale === briefLocale);
  if (exact.length > 0) return { fragments: exact, localeRelaxed: false };
  const prefix = briefLocale.split("-")[0] + "-";
  const prefixMatch = fragments.filter((f) => f.locale && f.locale.startsWith(prefix));
  if (prefixMatch.length > 0) return { fragments: prefixMatch, localeRelaxed: "prefix" };
  return { fragments, localeRelaxed: "any" };
}

function brandOverlap(fragment, briefBrands) {
  if (!briefBrands || briefBrands.length === 0) return { applies: false, overlap: [] };
  const fragBrands = fragment.brandGuidelinesApplied ?? [];
  const overlap = fragBrands.filter((b) => briefBrands.includes(b));
  return { applies: true, overlap };
}

function buildReason({ breakdown, localeRelaxed, briefLocale, fragmentLocale, brandOverlap: bo }) {
  const parts = [];
  if (breakdown.cosine >= 0.6) parts.push("strong semantic match");
  else if (breakdown.cosine >= 0.3) parts.push("partial semantic match");
  if (breakdown.bm25 >= 0.6) parts.push("strong keyword overlap");
  else if (breakdown.bm25 >= 0.3) parts.push("keyword overlap");
  if (bo.applies && bo.overlap.length > 0) parts.push(`brand: ${bo.overlap.join("+")}`);
  if (breakdown.freshness >= 0.7) parts.push("fresh content");
  else if (breakdown.freshness <= 0.2) parts.push("older content");
  if (localeRelaxed === "prefix") parts.push(`locale relaxed ${briefLocale}→${fragmentLocale}`);
  else if (localeRelaxed === "any") parts.push(`locale fallback ${briefLocale}→${fragmentLocale}`);
  let reason = parts.length > 0 ? parts.join("; ") : "weak match";
  reason = reason.charAt(0).toUpperCase() + reason.slice(1);
  if (reason.length > 140) reason = reason.slice(0, 139) + "…";
  return reason;
}

function normaliseBm25(scoredList) {
  const max = scoredList.reduce((m, x) => (x.score > m ? x.score : m), 0);
  if (max <= 0) return new Map();
  const norm = new Map();
  for (const { id, score } of scoredList) norm.set(id, clamp01(score / max));
  return norm;
}

export async function retrieve(brief, { source, k = 3, vectorDbPath = "data/embeddings.db", embedImpl = embed, now = Date.now() } = {}) {
  if (!source) throw new TypeError("retrieve(brief, { source }) requires a FragmentSource");
  if (!brief || !Array.isArray(brief.requiredTopics)) {
    throw new TypeError("retrieve requires a StructuredBrief with requiredTopics[]");
  }

  const isAem = source instanceof AemFragmentSource || source?.kind === "aem";

  let vectorStore = null;
  let vectorSearchAvailable = false;
  if (!isAem) {
    vectorStore = openVectorStore(vectorDbPath);
    vectorSearchAvailable = true;
  }

  const { fragments: allFragments } = await source.load();
  const localeFiltered = applyLocaleLadder(allFragments, brief.locale);
  const candidates = localeFiltered.fragments;
  const candidateIds = new Set(candidates.map((f) => f.id));
  const fragmentById = new Map(candidates.map((f) => [f.id, f]));

  const bm25 = buildBm25Index(candidates);

  try {
    const perFragmentBest = new Map();

    // Fold the brief-level theme into each per-topic query so generic topics
    // ("garment care instructions") stay anchored to the page's subject
    // ("sustainable winter collection") instead of matching any care guide.
    const theme = typeof brief.theme === "string" ? brief.theme.trim() : "";
    for (const topic of brief.requiredTopics) {
      const queryText = theme ? `${theme}: ${topic}` : topic;
      let vectorHits = [];
      if (vectorSearchAvailable && vectorStore) {
        const queryVec = await embedImpl(queryText);
        vectorHits = vectorStore.searchByVector(queryVec, {
          k: TOP_PER_QUERY,
          filterIds: candidateIds,
        });
      }
      const bm25Hits = bm25.searchByText(queryText, {
        k: TOP_PER_QUERY,
        filterIds: candidateIds,
      });

      const bm25Norm = normaliseBm25(bm25Hits);
      const cosineById = new Map();
      for (const h of vectorHits) cosineById.set(h.id, clamp01(h.score));

      const ids = new Set([...vectorHits.map((h) => h.id), ...bm25Hits.map((h) => h.id)]);

      for (const id of ids) {
        const f = fragmentById.get(id);
        if (!f) continue;
        const cosine = cosineById.get(id) ?? 0;
        const bm = bm25Norm.get(id) ?? 0;
        const fresh = freshnessScore(f.lastModified, now);
        const score = clamp01(WEIGHTS.cosine * cosine + WEIGHTS.bm25 * bm + WEIGHTS.freshness * fresh);
        const prev = perFragmentBest.get(id);
        if (!prev || score > prev.score) {
          perFragmentBest.set(id, { score, breakdown: { cosine, bm25: bm, freshness: fresh } });
        }
      }
    }

    const droppedByBrandFilter = [];
    const survived = [];
    for (const [id, s] of perFragmentBest) {
      const f = fragmentById.get(id);
      const bo = brandOverlap(f, brief.brandGuidelines);
      const reason = buildReason({
        breakdown: s.breakdown,
        localeRelaxed: localeFiltered.localeRelaxed,
        briefLocale: brief.locale,
        fragmentLocale: f.locale,
        brandOverlap: bo,
      });
      const match = { fragment: f, score: s.score, breakdown: s.breakdown, reason };
      if (bo.applies && bo.overlap.length === 0) droppedByBrandFilter.push(match);
      else survived.push(match);
    }

    survived.sort((a, b) => b.score - a.score);
    droppedByBrandFilter.sort((a, b) => b.score - a.score);

    return {
      matches: survived.slice(0, k),
      nearMisses: survived.slice(k, TOP_PER_QUERY),
      droppedByBrandFilter,
      localeRelaxed: localeFiltered.localeRelaxed,
      vectorSearchAvailable,
    };
  } finally {
    if (vectorStore) vectorStore.close();
  }
}
