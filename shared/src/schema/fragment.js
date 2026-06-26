import { z } from "zod";

export const FRAGMENT_CATEGORIES = ["product-story", "care-guide", "seasonal-campaign"];
export const FRAGMENT_LOCALES = ["en-gb", "fr-fr", "de-de"];

export const Fragment = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: z.enum(FRAGMENT_CATEGORIES),
  targetAudience: z.string().min(1),
  brandGuidelinesApplied: z.array(z.string()).min(1),
  locale: z.enum(FRAGMENT_LOCALES),
  lastModified: z.string().datetime(),
  content: z.string().min(1),
  path: z.string().optional(),
});

export function parseFragment(value) {
  return Fragment.parse(value);
}
