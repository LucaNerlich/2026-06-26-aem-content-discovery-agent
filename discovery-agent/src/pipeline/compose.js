import { z } from "zod";
import {
  AgentOutput,
  DraftOutline,
  chat as defaultChat,
  OllamaJsonParseError,
  getChatModel,
} from "@aemdisc/shared";

const SUMMARY_MAX_CHARS = 200;
const COMPOSE_NUM_PREDICT = 6000;

const BASE_SYSTEM_PROMPT = [
  "You compose a draft page outline for an AEM content brief.",
  "Output STRICT JSON matching this shape:",
  '{ "title": string, "pathHint": string, "sections": Section[] } where 4 <= sections.length <= 6.',
  "Each Section is EXACTLY ONE of these two shapes, never a mix:",
  '  REUSE: { "heading": string, "kind": "reuse", "fragmentIds": string[] (>=1, ONLY ids from matchedFragments below), "rationale": string }',
  '  NEW:   { "heading": string, "kind": "new",   "rationale": string, "sourcingHint": string }',
  "Rules:",
  "- Order sections as they would appear on the page (intro → body → close).",
  "- A reuse section's fragmentIds MUST all reference ids listed under matchedFragments — never invent ids.",
  "- A new section's sourcingHint should typically echo or refine a relevant gap's suggestedAction.",
  "- Do NOT add extra keys. Do NOT mix reuse fields with new fields in the same section.",
  "- Derive the title from the brief's audience + required topics. Set pathHint from the brief's pathHint.",
  "- Return ONLY the JSON object, no prose, no markdown fence.",
].join("\n");

function summariseFragment(match) {
  const frag = match.fragment ?? {};
  const raw = (frag.content ?? "").replace(/\s+/g, " ").trim();
  const summary =
    raw.length > SUMMARY_MAX_CHARS ? `${raw.slice(0, SUMMARY_MAX_CHARS)}…` : raw;
  return {
    id: frag.id,
    path: frag.path ?? "",
    title: frag.title ?? "",
    summary,
  };
}

function buildUserPayload(brief, fragmentSummaries, gaps) {
  return JSON.stringify({ brief, matchedFragments: fragmentSummaries, gaps }, null, 2);
}

function buildOrphanCheckedSchema(matchedFragments) {
  const validIds = new Set(matchedFragments.map((m) => m.id));
  return DraftOutline.superRefine((draft, ctx) => {
    draft.sections.forEach((section, idx) => {
      if (section.kind !== "reuse") return;
      section.fragmentIds.forEach((fid, fidIdx) => {
        if (!validIds.has(fid)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sections", idx, "fragmentIds", fidIdx],
            message: `orphan fragmentId "${fid}" — not present in matchedFragments`,
          });
        }
      });
    });
  });
}

async function callOutlineWithRetry({ chat, system, user, schema, model }) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sys =
      attempt === 0
        ? system
        : `${system}\n\nPrevious attempt failed validation: ${lastErr?.message ?? "(unknown)"}\nReturn ONLY valid JSON matching the schema above.`;
    try {
      const raw = await chat({
        system: sys,
        user,
        json: true,
        model,
        options: { num_predict: COMPOSE_NUM_PREDICT },
      });
      return schema.parse(raw);
    } catch (err) {
      const retriable = err instanceof OllamaJsonParseError || err instanceof z.ZodError;
      if (attempt === 0 && retriable) {
        lastErr = err;
        continue;
      }
      if (err instanceof z.ZodError) {
        // Fail loud per spec — this is the last LLM call.
        console.error(
          "compose: draftOutline schema validation failed after retry",
          JSON.stringify(err.issues, null, 2),
        );
      }
      throw err;
    }
  }
  // Unreachable: loop either returns or throws.
  throw new Error("compose: unreachable retry state");
}

export async function compose(
  structuredBrief,
  retrievalResult,
  gaps,
  { chat = defaultChat, model = getChatModel("compose") } = {},
) {
  const matches = Array.isArray(retrievalResult?.matches)
    ? retrievalResult.matches.slice(0, 3)
    : [];

  const matchedFragments = matches.map((m) => ({
    id: m.fragment?.id,
    path: m.fragment?.path ?? "",
    score: m.score,
    reason: m.reason,
  }));

  const fragmentSummaries = matches.map(summariseFragment);
  const user = buildUserPayload(structuredBrief, fragmentSummaries, gaps);
  const schema = buildOrphanCheckedSchema(matchedFragments);

  let draftOutline = await callOutlineWithRetry({
    chat,
    system: BASE_SYSTEM_PROMPT,
    user,
    schema,
    model,
  });

  if (structuredBrief?.pathHint) {
    draftOutline = { ...draftOutline, pathHint: structuredBrief.pathHint };
  }

  return AgentOutput.parse({
    schemaVersion: "1.0",
    brief: structuredBrief,
    matchedFragments,
    gaps,
    draftOutline,
  });
}
