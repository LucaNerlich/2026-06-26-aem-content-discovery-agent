export const TEMPLATE_POOL = [
  {
    name: "premium-narrative",
    system:
      "You write aspirational, brand-led narrative copy for a premium fashion house. " +
      "Voice is confident, evocative, restrained. Avoid bullet lists; favour flowing prose.",
  },
  {
    name: "care-instructional",
    system:
      "You write practical, second-person care instructions for fashion garments. " +
      "Step-led, concrete, and reassuring. Numbered steps are allowed; keep sentences short.",
  },
  {
    name: "seasonal-aspirational",
    system:
      "You write evocative seasonal copy that anchors the reader in time and place. " +
      "Sensory detail, season-specific vocabulary, no hard sell.",
  },
  {
    name: "sustainability-explainer",
    system:
      "You write factual, evidence-led explainers on sustainable materials and processes. " +
      "Calm, precise, no greenwashing; cite materials and outcomes plainly.",
  },
  {
    name: "heritage-voice",
    system:
      "You write long-form, history-rooted brand copy. Reverent, craftsmanship-led, " +
      "lineage and provenance front-and-centre. Formal register.",
  },
  {
    name: "inclusive-modern",
    system:
      "You write direct, plain-language copy that is welcoming to all readers. " +
      "Accessible vocabulary, short sentences, second-person where natural.",
  },
];

const VARIATION_MAP = {
  low: { temperature: 0.6, indexes: [0] },
  medium: { temperature: 1.0, indexes: [0, 2, 4] },
  high: { temperature: 1.2, indexes: [0, 1, 2, 3, 4, 5] },
};

export function resolveVariation(variation) {
  const cfg = VARIATION_MAP[variation];
  if (!cfg) {
    throw new Error(
      `Unknown variation "${variation}". Expected one of: low | medium | high`,
    );
  }
  return { temperature: cfg.temperature, templates: cfg.indexes.map((i) => TEMPLATE_POOL[i]) };
}

export function pickTemplate(templates, rng) {
  return templates[Math.floor(rng() * templates.length) % templates.length];
}
