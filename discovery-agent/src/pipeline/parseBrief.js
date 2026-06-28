import {
  chat as defaultChat,
  getChatModel,
  LlmJsonParseError,
  parseStructuredBrief,
} from "@aemdisc/shared";

const LOCALE_REGEX = /\/(en-gb|fr-fr|de-de)\//;
const KNOWN_LOCALES = new Set(["en-gb", "fr-fr", "de-de"]);
const DEFAULT_LOCALE = "en-gb";

const BRAND_VOCAB = [
  "sustainability-voice",
  "premium-tone",
  "inclusive-language",
  "technical-precision",
];

const BASE_SYSTEM = `You parse free-form content briefs into strict JSON.

Return ONLY a JSON object with these fields:
- audience: short string describing the target audience.
- locale: one of "en-gb", "fr-fr", "de-de". Infer from country/region in the audience when no URL is present.
- theme: short phrase capturing the overall subject of the page (e.g. "sustainable winter collection", "premium loungewear"). This is the unifying context that the individual requiredTopics share.
- tone: short string describing the desired tone (e.g. "premium", "casual", "technical").
- brandGuidelines: array of strings drawn ONLY from this locked vocabulary: ${JSON.stringify(BRAND_VOCAB)}. Include only those that clearly apply.
- requiredTopics: array of 2-6 short topic labels the page must cover.
- pathHint: suggested URL path (e.g. "/en-gb/collections/winter-sustainable"); empty string if not derivable.

Do not invent brand guidelines outside the locked vocabulary. Do not add extra fields. Do not wrap the JSON in prose.`;

function detectLocaleFromPath(rawText) {
  const m = rawText.match(LOCALE_REGEX);
  return m ? m[1] : null;
}

function isShapeError(err) {
  return err instanceof LlmJsonParseError || err?.name === "ZodError";
}

const PARSE_BRIEF_NUM_PREDICT = 2500;

async function callOnce({ chat, system, user, model }) {
  const raw = await chat({
    system,
    user,
    json: true,
    model,
    options: { num_predict: PARSE_BRIEF_NUM_PREDICT },
  });
  return parseStructuredBrief(raw);
}

export async function parseBrief(
  rawText,
  { chat = defaultChat, model = getChatModel("parseBrief") } = {},
) {
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    throw new TypeError("parseBrief(rawText) requires a non-empty string");
  }

  const pathLocale = detectLocaleFromPath(rawText);
  const localeHint = pathLocale
    ? `A URL/path in the brief indicates locale "${pathLocale}". Set "locale" to that value.`
    : `No locale was found in any URL/path. Infer locale from the audience description; if ambiguous, use "${DEFAULT_LOCALE}".`;

  const system = `${BASE_SYSTEM}\n\n${localeHint}`;

  let brief;
  try {
    brief = await callOnce({ chat, system, user: rawText, model });
  } catch (err) {
    if (!isShapeError(err)) throw err;
    const retrySystem1 = `${system}\n\nThe previous attempt failed validation: ${err.message}. Return strict JSON matching the schema exactly, with no extra fields. requiredTopics must be a non-empty array of non-empty strings derived from the brief.`;
    try {
      brief = await callOnce({ chat, system: retrySystem1, user: rawText, model });
    } catch (err2) {
      if (!isShapeError(err2)) throw err2;
      const retrySystem2 = `${retrySystem1}\n\nReturn ONLY valid JSON. No prose, no markdown fences, no comments.`;
      brief = await callOnce({ chat, system: retrySystem2, user: rawText, model });
    }
  }

  if (typeof brief.theme !== "string") brief.theme = "";

  const uncertain = [];

  if (pathLocale) {
    if (brief.locale !== pathLocale) {
      uncertain.push(`model returned locale "${brief.locale}" but URL/path indicated "${pathLocale}"; using path locale`);
      brief.locale = pathLocale;
    }
  } else if (!KNOWN_LOCALES.has(brief.locale)) {
    uncertain.push(`locale "${brief.locale}" not in {en-gb,fr-fr,de-de}; defaulted to "${DEFAULT_LOCALE}"`);
    brief.locale = DEFAULT_LOCALE;
  }

  if (uncertain.length > 0) {
    brief.uncertain = [...(brief.uncertain ?? []), ...uncertain];
  }

  return parseStructuredBrief(brief);
}
