import { z } from "zod";

export const StructuredBrief = z.object({
  audience: z.string().min(1),
  locale: z.string().min(1),
  tone: z.string().min(1),
  // Overall subject of the page (e.g. "sustainable winter collection"). Carries
  // the brief-level context that individual requiredTopics lose, so retrieval can
  // disambiguate generic topics ("garment care") toward the right theme. Optional
  // for backward compatibility; retrieval falls back to bare topics when absent.
  theme: z.string().optional(),
  brandGuidelines: z.array(z.string()),
  requiredTopics: z.array(z.string().min(1)).min(1),
  pathHint: z.string(),
  uncertain: z.array(z.string()).optional(),
});

export function parseStructuredBrief(value) {
  return StructuredBrief.parse(value);
}
