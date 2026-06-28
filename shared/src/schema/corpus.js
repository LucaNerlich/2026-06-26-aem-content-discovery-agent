import { z } from "zod";
import { Fragment } from "./fragment.js";

export const Corpus = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string().datetime(),
  model: z.string().min(1),
  embeddingModel: z.string().min(1),
  // Provenance: the seeder inputs that make this corpus reproducible. Optional so
  // older corpus files (and lightweight test fixtures) still parse. The eval relies
  // on (seed, perLocaleCount, locales) to confirm a corpus matches its labels.
  seed: z.number().int().nonnegative().optional(),
  perLocaleCount: z.number().int().positive().optional(),
  locales: z.array(z.string().min(1)).optional(),
  fragments: z.array(Fragment),
});

export function parseCorpus(value) {
  return Corpus.parse(value);
}
