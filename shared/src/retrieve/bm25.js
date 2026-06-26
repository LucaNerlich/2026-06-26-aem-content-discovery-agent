import bm25Factory from "wink-bm25-text-search";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has",
  "have", "in", "is", "it", "its", "of", "on", "or", "that", "the", "this",
  "to", "was", "were", "will", "with",
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOP_WORDS.has(t));
}

export function buildBm25Index(fragments) {
  const engine = bm25Factory();
  engine.defineConfig({
    fldWeights: { title: 3, content: 1, targetAudience: 1 },
  });
  engine.definePrepTasks([tokenize]);

  const idForRow = [];
  fragments.forEach((f, i) => {
    engine.addDoc(
      {
        title: f.title ?? "",
        content: f.content ?? "",
        targetAudience: f.targetAudience ?? "",
      },
      i,
    );
    idForRow[i] = f.id;
  });

  let consolidated = false;
  if (fragments.length >= 3) {
    engine.consolidate();
    consolidated = true;
  }

  function searchByText(query, { k = 15, filterIds } = {}) {
    if (!query || typeof query !== "string" || !consolidated) return [];
    const filterSet = filterIds instanceof Set ? filterIds : filterIds ? new Set(filterIds) : null;
    let raw;
    try {
      raw = engine.search(query, Math.max(k, fragments.length));
    } catch {
      return [];
    }
    const out = [];
    for (const [docIdx, score] of raw) {
      const id = idForRow[docIdx];
      if (filterSet && !filterSet.has(id)) continue;
      out.push({ id, score });
      if (out.length >= k) break;
    }
    return out;
  }

  return { searchByText };
}
