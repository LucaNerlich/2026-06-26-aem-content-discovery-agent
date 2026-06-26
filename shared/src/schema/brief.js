import { z } from "zod";

export const StructuredBrief = z.object({
  audience: z.string().min(1),
  locale: z.string().min(1),
  tone: z.string().min(1),
  brandGuidelines: z.array(z.string()),
  requiredTopics: z.array(z.string()),
  pathHint: z.string(),
});

export function parseStructuredBrief(value) {
  return StructuredBrief.parse(value);
}
