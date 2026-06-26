import { z } from "zod";
import { Fragment } from "./fragment.js";

export const Corpus = z.object({
  schemaVersion: z.literal("1.0"),
  generatedAt: z.string().datetime(),
  model: z.string().min(1),
  embeddingModel: z.string().min(1),
  fragments: z.array(Fragment),
});

export function parseCorpus(value) {
  return Corpus.parse(value);
}
