import {
  fakerEN_GB,
  fakerFR,
  fakerDE,
} from "@faker-js/faker";
import { chat, getChatModel, parseFragment, FRAGMENT_CATEGORIES, LlmInvariantError } from "@aemdisc/shared";
import { resolveVariation, pickTemplate } from "./templates.js";
import { RESERVED_COUNT, reservedForLocale, pickRandomTopic } from "./topics.js";
import { createRng, shuffle } from "./rng.js";

const BRAND_GUIDELINES = ["sustainability-voice", "premium-tone", "inclusive-language"];
const EIGHTEEN_MONTHS_MS = 18 * 30 * 24 * 60 * 60 * 1000;
const SEEDER_NUM_PREDICT = 1024;

const LOCALE_CONFIG = {
  "en-gb": { faker: fakerEN_GB, language: "British English", label: "en-GB" },
  "fr-fr": { faker: fakerFR, language: "French (France)", label: "fr-FR" },
  "de-de": { faker: fakerDE, language: "German (Germany)", label: "de-DE" },
};

export function getLocaleConfig(locale) {
  const cfg = LOCALE_CONFIG[locale];
  if (!cfg) throw new Error(`Unsupported locale: ${locale}`);
  return cfg;
}

function pickBrandGuidelines(rng) {
  // 1-3 tags, weighted towards 1-2.
  const r = rng();
  const n = r < 0.45 ? 1 : r < 0.9 ? 2 : 3;
  const shuffled = shuffle(BRAND_GUIDELINES, rng);
  return shuffled.slice(0, n);
}

function isoLastModified(rng, now) {
  const offset = Math.floor(rng() * EIGHTEEN_MONTHS_MS);
  return new Date(now - offset).toISOString();
}

function audienceFor(category, faker) {
  const age1 = faker.number.int({ min: 22, max: 38 });
  const age2 = age1 + faker.number.int({ min: 6, max: 18 });
  const gender = faker.helpers.arrayElement(["women", "men", "all genders"]);
  const market = faker.location.country();
  if (category === "care-guide") {
    return `Existing customers (${gender}, ${age1}-${age2}), ${market}, seeking guidance on garment longevity.`;
  }
  if (category === "seasonal-campaign") {
    return `Brand-engaged shoppers (${gender}, ${age1}-${age2}), ${market}, browsing seasonal collections.`;
  }
  return `Quality-led shoppers (${gender}, ${age1}-${age2}), ${market}, interested in considered fashion.`;
}

function buildUserPrompt({ topic, locale, category, audience, brandGuidelines }) {
  const cfg = getLocaleConfig(locale);
  return [
    `Write the body copy for an AEM Content Fragment.`,
    ``,
    `Topic: ${topic.title}`,
    `Keywords to weave in naturally: ${topic.keywords.join(", ")}`,
    `Locale: ${cfg.label} (write in ${cfg.language})`,
    `Editorial category: ${category}`,
    `Target audience: ${audience}`,
    `Brand guidelines applied: ${brandGuidelines.join(", ")}`,
    ``,
    `Length: 150-250 words. Hard minimum 100 words.`,
    `Return prose only. No markdown, no headings, no bullet lists unless the category is "care-guide" and steps make the content materially clearer.`,
    `Do not restate the title verbatim.`,
  ].join("\n");
}

function titleFor(topic, locale, faker) {
  // Light per-locale flavour; keep meaning aligned with the topic.
  const suffix = faker.helpers.arrayElement(["", " - collection notes", " - editorial", " - guide", ""]);
  const localePrefix = locale === "fr-fr" ? "" : locale === "de-de" ? "" : "";
  return `${localePrefix}${topic.title}${suffix}`.trim();
}

function balancedCategoryFor(index, isReserved, topic) {
  if (isReserved) return topic.category;
  // Round-robin across categories for random-slot fragments.
  return FRAGMENT_CATEGORIES[index % FRAGMENT_CATEGORIES.length];
}

function topicMatchingCategory(rng, category) {
  // Try a few times to find a random topic matching the requested category.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const t = pickRandomTopic(rng);
    if (t.category === category) return t;
  }
  return pickRandomTopic(rng);
}

export function planFragments({ locales, count, seed }) {
  const plan = [];
  let globalIndex = 0;
  locales.forEach((locale, localeIdx) => {
    const reservedTopics = reservedForLocale(localeIdx);
    const reservedCount = Math.min(count, RESERVED_COUNT);
    const localeRng = createRng((seed + localeIdx * 1009) >>> 0);
    for (let i = 0; i < count; i += 1) {
      globalIndex += 1;
      const isReserved = i < reservedCount;
      const topic = isReserved
        ? reservedTopics[i]
        : topicMatchingCategory(localeRng, FRAGMENT_CATEGORIES[i % FRAGMENT_CATEGORIES.length]);
      const category = balancedCategoryFor(i, isReserved, topic);
      plan.push({
        globalIndex,
        localeIndex: localeIdx,
        slotIndex: i,
        locale,
        isReserved,
        topic,
        category,
      });
    }
  });
  return plan;
}

export async function generateFragment({ entry, seed, variation, now = Date.now(), chatImpl = chat }) {
  const cfg = getLocaleConfig(entry.locale);
  const { temperature, templates } = resolveVariation(variation);
  const fragmentSeed = (seed + entry.globalIndex * 7919) >>> 0;
  const rng = createRng(fragmentSeed);
  cfg.faker.seed(fragmentSeed);

  const id = `frag_${String(entry.globalIndex).padStart(3, "0")}`;
  const title = titleFor(entry.topic, entry.locale, cfg.faker);
  const audience = audienceFor(entry.category, cfg.faker);
  const brandGuidelines = pickBrandGuidelines(rng);
  const lastModified = isoLastModified(rng, now);
  const template = pickTemplate(templates, rng);
  const user = buildUserPrompt({
    topic: entry.topic,
    locale: entry.locale,
    category: entry.category,
    audience,
    brandGuidelines,
  });
  let content = await chatImpl({
    system: template.system,
    user,
    model: getChatModel("seeder"),
    options: { temperature, num_predict: SEEDER_NUM_PREDICT },
  }).catch((err) => {
    // Thinking models sometimes exhaust their token budget on <think> blocks and return
    // empty content. Retry once with an explicit "no thinking tags" instruction.
    if (err instanceof LlmInvariantError && err.message.includes("empty response")) {
      return chatImpl({
        system: template.system,
        user: user + "\n\nIMPORTANT: Output only the prose content. Do not use <think> or any XML-style tags.",
        model: getChatModel("seeder"),
        options: { temperature, num_predict: SEEDER_NUM_PREDICT },
      });
    }
    throw err;
  });

  return parseFragment({
    id,
    title,
    category: entry.category,
    targetAudience: audience,
    brandGuidelinesApplied: brandGuidelines,
    locale: entry.locale,
    lastModified,
    content: typeof content === "string" ? content.trim() : String(content),
    path: `/content/dam/aemcontentdisc/${entry.locale}/${id}`,
  });
}
