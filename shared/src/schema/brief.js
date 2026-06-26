import { z } from "zod";

export const StructuredBrief = z.object({
  audience: z.string().min(1),
  locale: z.string().min(1),
  tone: z.string().min(1),
  brandGuidelines: z.array(z.string()),
  requiredTopics: z.array(z.string().min(1)).min(1),
  pathHint: z.string(),
  uncertain: z.array(z.string()).optional(),
});

export function parseStructuredBrief(value) {
  return StructuredBrief.parse(value);
}
