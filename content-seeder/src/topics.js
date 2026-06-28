// Reserved topic pool: guarantees the demo brief
// (eco-conscious UK women, winter, sustainability) has ≥6 retrievable matches per locale.
export const RESERVED_TOPICS = [
  {
    title: "Women's winter coats - recycled wool and sustainable insulation",
    category: "product-story",
    keywords: ["winter coats", "recycled wool", "responsibly sourced insulation", "women's outerwear"],
  },
  {
    title: "Sustainable knitwear and natural fibres for cold weather",
    category: "product-story",
    keywords: ["merino wool", "organic cotton", "natural fibres", "cold-weather knitwear"],
  },
  {
    title: "Care guide: extending the life of winter garments",
    category: "care-guide",
    keywords: ["washing wool", "repair", "longevity", "winter garment care"],
  },
  {
    title: "Seasonal collection story: autumn / winter campaign",
    category: "seasonal-campaign",
    keywords: ["autumn winter", "seasonal launch", "campaign narrative", "premium collection"],
  },
  {
    title: "Recycled materials and circular fashion in outerwear",
    category: "product-story",
    keywords: ["recycled polyester", "circular fashion", "closed-loop", "outerwear materials"],
  },
  {
    title: "Layering essentials with natural fibres",
    category: "product-story",
    keywords: ["layering", "merino base layers", "organic cotton", "winter essentials"],
  },
];

export const RESERVED_COUNT = RESERVED_TOPICS.length;

// Random topic pool - intentionally broad so we don't bias the demo retrieval test.
export const RANDOM_TOPICS = [
  { title: "Summer linen essentials for warm climates", category: "product-story", keywords: ["linen", "summer", "lightweight"] },
  { title: "Smart-casual tailoring for the modern workplace", category: "product-story", keywords: ["tailoring", "workwear", "blazer"] },
  { title: "How to store leather accessories", category: "care-guide", keywords: ["leather care", "storage", "conditioning"] },
  { title: "Removing common stains from delicate fabrics", category: "care-guide", keywords: ["stain removal", "delicates", "silk"] },
  { title: "Spring campaign: garden party styling", category: "seasonal-campaign", keywords: ["spring", "garden party", "florals"] },
  { title: "Festival season: bold colour and texture", category: "seasonal-campaign", keywords: ["festival", "summer", "colour"] },
  { title: "Hand-finished leather goods from heritage workshops", category: "product-story", keywords: ["leather", "heritage", "craftsmanship"] },
  { title: "Silk scarves: traditional weaving techniques", category: "product-story", keywords: ["silk", "weaving", "heritage"] },
  { title: "Resort wear: lightweight pieces for travel", category: "product-story", keywords: ["resort", "travel", "vacation"] },
  { title: "Daily-wear denim: fits and fabrics", category: "product-story", keywords: ["denim", "fit guide", "everyday"] },
  { title: "Caring for cashmere through the seasons", category: "care-guide", keywords: ["cashmere", "knitwear care", "seasonal"] },
  { title: "How to fold and travel with tailored shirts", category: "care-guide", keywords: ["shirt care", "travel folding", "packing"] },
  { title: "Polishing and protecting fine footwear", category: "care-guide", keywords: ["footwear care", "polishing", "leather shoes"] },
  { title: "Pre-fall edit: between-season layering pieces", category: "seasonal-campaign", keywords: ["pre-fall", "layering", "transitional"] },
  { title: "Holiday gifting: timeless accessories", category: "seasonal-campaign", keywords: ["holiday", "gifting", "accessories"] },
  { title: "High summer: linen suiting for warm-weather events", category: "seasonal-campaign", keywords: ["high summer", "linen suiting", "events"] },
  { title: "Capsule wardrobe: ten pieces, one season", category: "product-story", keywords: ["capsule", "wardrobe", "essentials"] },
  { title: "Evening wear: silk slip dresses and tailored tuxedos", category: "product-story", keywords: ["evening wear", "silk", "tuxedo"] },
  { title: "Athleisure done with restraint", category: "product-story", keywords: ["athleisure", "minimal", "comfort"] },
  { title: "Hat care: shaping, brushing, storage", category: "care-guide", keywords: ["hats", "shaping", "storage"] },
];

export function reservedForLocale(localeIndex) {
  // Rotate the reserved set per locale to avoid identical title order across locales.
  const offset = localeIndex % RESERVED_TOPICS.length;
  return [
    ...RESERVED_TOPICS.slice(offset),
    ...RESERVED_TOPICS.slice(0, offset),
  ];
}

export function pickRandomTopic(rng) {
  return RANDOM_TOPICS[Math.floor(rng() * RANDOM_TOPICS.length) % RANDOM_TOPICS.length];
}
