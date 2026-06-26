import { z } from "zod";
import { StructuredBrief } from "./brief.js";

export const MatchedFragment = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  score: z.number().min(0).max(1),
  reason: z.string().max(140),
});

export const GAP_COVERAGE = ["none", "partial"];

export const Gap = z.object({
  topic: z.string().min(1),
  coverage: z.enum(GAP_COVERAGE),
  description: z.string().min(1),
  partialMatches: z.array(z.string()),
  suggestedAction: z.string().min(1),
});

export const ReuseSection = z
  .object({
    heading: z.string().min(1),
    kind: z.literal("reuse"),
    fragmentIds: z.array(z.string()).min(1),
    rationale: z.string().min(1),
  })
  .strict();

export const NewSection = z
  .object({
    heading: z.string().min(1),
    kind: z.literal("new"),
    rationale: z.string().min(1),
    sourcingHint: z.string().min(1),
  })
  .strict();

export const SectionUnion = z.discriminatedUnion("kind", [ReuseSection, NewSection]);

export const DraftOutline = z.object({
  title: z.string().min(1),
  pathHint: z.string(),
  sections: z.array(SectionUnion),
});

export const AgentOutput = z.object({
  schemaVersion: z.literal("1.0"),
  brief: StructuredBrief,
  matchedFragments: z.array(MatchedFragment).max(3),
  gaps: z.array(Gap),
  draftOutline: DraftOutline,
});

export function parseAgentOutput(value) {
  return AgentOutput.parse(value);
}
