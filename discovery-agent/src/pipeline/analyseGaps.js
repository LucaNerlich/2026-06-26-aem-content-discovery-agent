import { z } from "zod";
import {
  chat as defaultChat,
  getChatModel,
  Gap as GapSchema,
  GAP_COVERAGE,
  LlmJsonParseError,
} from "@aemdisc/shared";

const TopicVerdict = z.object({
  topic: z.string().min(1),
  coverage: z.enum(GAP_COVERAGE),
  description: z.string().min(1),
  partialMatches: z.array(z.string()),
  rationale: z.string().min(1),
});
// LM Studio JSON output is prompt-driven and requires a top-level JSON
// object, so the model is asked to return `{ "verdicts": [...] }`. We also
// accept a bare array for backwards compatibility with tests and fixture fakes.
const JudgeOutput = z.union([
  z.object({ verdicts: z.array(TopicVerdict) }),
  z.array(TopicVerdict),
]);

function unwrapVerdicts(parsed) {
  return Array.isArray(parsed) ? parsed : parsed.verdicts;
}

const CONTENT_HEAD = 160;
const ANALYSE_GAPS_NUM_PREDICT = 4000;

function summariseFragment(fragment, sources) {
  const head = (fragment.content ?? "").slice(0, CONTENT_HEAD).replace(/\s+/g, " ").trim();
  return {
    id: fragment.id,
    title: fragment.title,
    locale: fragment.locale,
    brandGuidelinesApplied: fragment.brandGuidelinesApplied,
    lastModified: fragment.lastModified,
    sources: [...sources],
    contentHead: head,
  };
}

function buildPool(retrievalResult) {
  const pool = new Map();
  const add = (match, source) => {
    if (!match?.fragment?.id) return;
    const existing = pool.get(match.fragment.id);
    if (existing) {
      existing.sources.add(source);
    } else {
      pool.set(match.fragment.id, { fragment: match.fragment, sources: new Set([source]) });
    }
  };
  (retrievalResult.matches ?? []).forEach((m) => add(m, "matches"));
  (retrievalResult.nearMisses ?? []).forEach((m) => add(m, "nearMisses"));
  (retrievalResult.droppedByBrandFilter ?? []).forEach((m) => add(m, "droppedByBrandFilter"));
  return pool;
}

function inferCategory(topic) {
  const t = String(topic).toLowerCase();
  if (/(care|wash|repair|longevity|maintain|extend)/.test(t)) return "care-guide";
  if (/(campaign|seasonal|collection launch|holiday|festival)/.test(t)) return "seasonal-campaign";
  return "product-story";
}

function suggestedActionForTopic(topic, brief) {
  const cat = inferCategory(topic);
  const gl = brief.brandGuidelines?.length
    ? `, applying ${brief.brandGuidelines.join(" and ")}`
    : "";
  return `Write a 200-word ${brief.locale} ${cat} fragment covering "${topic}"${gl}.`;
}

function localeSuggestion(brief) {
  return `Author or translate at least one fragment in ${brief.locale} so retrieval no longer relaxes the locale filter for this brief.`;
}

function brandSuggestion(brief, guideline) {
  const others = (brief.brandGuidelines ?? []).filter((g) => g !== guideline);
  const co = others.length ? ` (alongside ${others.join(", ")})` : "";
  return `Add fragments tagged \`${guideline}\`${co} for the ${brief.locale} corpus so this brand voice is represented in the top matches.`;
}

function buildSystemPrompt(brief) {
  return [
    "You are a content gap auditor for an AEM Content Discovery agent.",
    "Given a structured brief and a pool of candidate Content Fragments, classify EACH required topic from the brief as either:",
    `  - "none" - no fragment in the pool substantively addresses the topic`,
    `  - "partial" - at least one fragment touches the topic but coverage is incomplete (wrong locale, shallow, stale, missing brand voice, brand-filter dropped)`,
    "",
    `Brief: locale=${brief.locale}; audience=${brief.audience}; tone=${brief.tone}; brandGuidelines=[${(brief.brandGuidelines ?? []).join(", ")}].`,
    `Required topics (return one verdict per topic, in the same order):`,
    ...(brief.requiredTopics ?? []).map((t, i) => `  ${i + 1}. ${t}`),
    "",
    'Return STRICTLY a JSON object of the form { "verdicts": [ ... ] } where each verdict has this schema: { "topic": string, "coverage": "none" | "partial", "description": string (1-2 sentences explaining what is missing), "partialMatches": string[] (fragment ids that partially cover the topic; MUST be empty when coverage=="none"), "rationale": string (1 sentence) }. Provide exactly one verdict per required topic, in the same order as the topics above.',
    "Use ONLY fragment ids that appear in the candidate pool below.",
  ].join("\n");
}

function buildUserPrompt(pool) {
  const items = [...pool.values()].map(({ fragment, sources }) => summariseFragment(fragment, sources));
  return `Candidate pool (JSON):\n${JSON.stringify(items, null, 2)}`;
}

async function judge({ chat, model, brief, pool }) {
  if (pool.size === 0 || (brief.requiredTopics ?? []).length === 0) {
    return (brief.requiredTopics ?? []).map((topic) => ({
      topic,
      coverage: "none",
      description: "No fragment in the candidate pool addresses this topic.",
      partialMatches: [],
      rationale: "Empty candidate pool.",
    }));
  }
  const system = buildSystemPrompt(brief);
  const user = buildUserPrompt(pool);

  const callOnce = async (sys) => {
    const raw = await chat({
      system: sys,
      user,
      json: true,
      model,
      options: { num_predict: ANALYSE_GAPS_NUM_PREDICT },
    });
    return unwrapVerdicts(JudgeOutput.parse(raw));
  };

  try {
    return await callOnce(system);
  } catch (err) {
    if (err instanceof LlmJsonParseError || err instanceof z.ZodError) {
      const augmented = `${system}\n\nPrevious attempt failed validation: ${err.message}\nReturn ONLY a JSON object of the form { "verdicts": [ ... ] } matching the schema; do not include prose around the JSON.`;
      return await callOnce(augmented);
    }
    throw err;
  }
}

function sanitiseVerdict(verdict, topic, pool) {
  const validIds = new Set([...pool.keys()]);
  let partialMatches = (verdict.partialMatches ?? []).filter((id) => validIds.has(id));
  let coverage = verdict.coverage;
  if (coverage === "partial" && partialMatches.length === 0) coverage = "none";
  if (coverage === "none") partialMatches = [];
  return {
    topic,
    coverage,
    description: verdict.description ?? "No fragment in the candidate pool addresses this topic.",
    partialMatches,
  };
}

function buildStructuralGaps(brief, retrievalResult, pool) {
  const out = [];
  const matches = retrievalResult.matches ?? [];

  if (retrievalResult.localeRelaxed && retrievalResult.localeRelaxed !== false) {
    const relaxedIds = matches
      .map((m) => m?.fragment)
      .filter((f) => f && f.locale !== brief.locale)
      .map((f) => f.id)
      .filter((id) => pool.has(id));
    out.push({
      topic: `Locale-appropriate content for ${brief.locale}`,
      coverage: relaxedIds.length > 0 ? "partial" : "none",
      description:
        `Retrieval relaxed the locale filter (mode: ${retrievalResult.localeRelaxed}); ` +
        `the top matches are not in ${brief.locale}.`,
      partialMatches: relaxedIds,
      suggestedAction: localeSuggestion(brief),
    });
  }

  const briefBrand = brief.brandGuidelines ?? [];
  if (briefBrand.length > 0) {
    const droppedIds = (retrievalResult.droppedByBrandFilter ?? [])
      .map((m) => m?.fragment?.id)
      .filter((id) => id && pool.has(id));
    const guidelinesInMatches = new Set();
    for (const m of matches) {
      for (const g of m?.fragment?.brandGuidelinesApplied ?? []) guidelinesInMatches.add(g);
    }
    for (const guideline of briefBrand) {
      if (guidelinesInMatches.has(guideline)) continue;
      out.push({
        topic: `Brand guideline coverage: ${guideline}`,
        coverage: droppedIds.length > 0 ? "partial" : "none",
        description:
          `No top match applies the \`${guideline}\` brand guideline required by the brief.` +
          (droppedIds.length > 0
            ? ` Some candidates exist but lacked any required brand guideline and were filtered out.`
            : ""),
        partialMatches: droppedIds.length > 0 ? droppedIds : [],
        suggestedAction: brandSuggestion(brief, guideline),
      });
    }
  }

  return out;
}

export async function analyseGaps(
  structuredBrief,
  retrievalResult,
  { chat = defaultChat, model = getChatModel("analyseGaps") } = {},
) {
  if (!structuredBrief || typeof structuredBrief !== "object") {
    throw new TypeError("analyseGaps requires a structuredBrief object");
  }
  if (!retrievalResult || typeof retrievalResult !== "object") {
    throw new TypeError("analyseGaps requires a retrievalResult object");
  }

  const pool = buildPool(retrievalResult);
  const verdicts = await judge({ chat, model, brief: structuredBrief, pool });

  const verdictByTopic = new Map();
  for (const v of verdicts) verdictByTopic.set(v.topic, v);

  const gaps = [];
  for (const topic of structuredBrief.requiredTopics ?? []) {
    const verdict =
      verdictByTopic.get(topic) ?? {
        topic,
        coverage: "none",
        description: "No verdict returned by the judge; treated as no coverage.",
        partialMatches: [],
      };
    const cleaned = sanitiseVerdict(verdict, topic, pool);
    gaps.push({
      topic: cleaned.topic,
      coverage: cleaned.coverage,
      description: cleaned.description,
      partialMatches: cleaned.partialMatches,
      suggestedAction: suggestedActionForTopic(topic, structuredBrief),
    });
  }

  gaps.push(...buildStructuralGaps(structuredBrief, retrievalResult, pool));

  return gaps.map((g) => GapSchema.parse(g));
}
