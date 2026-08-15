/**
 * Guards against wrong product matches from the pricing API.
 *
 * Two real failures motivated this, both of which silently corrupted meal
 * costs and the weekly budget:
 *  - "mixed peppers" matched a jar of Tellicherry BLACK PEPPERCORNS, because
 *    a naive substring test accepts "pepper" ⊂ "mixed peppers". At 70g a jar
 *    against 480g of bell peppers, that one line came to £27.
 *  - "scallops" matched "Large Whole Chicken 2.0-2.5kg" — no relationship at
 *    all, just whatever the API surfaced.
 *
 * Rejecting a doubtful match is much better than accepting it: an unmatched
 * ingredient falls back to a flagged hand estimate, which is clearly marked
 * in the shopping email, whereas a bad match is invisible and wrong.
 */

/** Words that carry no identifying signal when comparing a recipe line to a SKU. */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "and", "with", "in", "for", "fresh", "frozen", "chilled",
  "organic", "free", "range", "british", "large", "small", "medium", "value",
  "essential", "finest", "taste", "difference", "sainsburys", "sainsbury", "co",
  "stamford", "street", "pack", "packet", "whole", "cut", "ready", "mix", "mixed",
  "plain", "natural", "classic", "original", "g", "kg", "ml", "l", "x",
]);

/**
 * Product names and recipe lines routinely disagree about spelling or use
 * a different name for the same thing ("yoghurt"/"yogurt",
 * "parmesan"/"parmigiano"). Without these, correct matches get thrown away
 * and replaced by estimates, which loses real price data.
 */
const SYNONYMS: Record<string, string> = {
  yogurt: "yoghurt",
  parmigiano: "parmesan",
  reggiano: "parmesan",
  aubergine: "eggplant",
  coriander: "cilantro",
  prawn: "shrimp",
  gherkin: "pickle",
  pickled: "pickle",
  courgette: "zucchini",
  minced: "mince",
  chickpea: "garbanzo",
  passata: "tomato",
  petit: "bun",
  pain: "bun",
  bap: "bun",
  roll: "bun",
  noodle: "noodle",
  spaghetti: "pasta",
  linguine: "pasta",
  tagliatelle: "pasta",
};

function normalise(w: string): string {
  const s = stem(w);
  return SYNONYMS[s] ?? s;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Crude singularisation, enough to align "peppers"/"pepper",
 * "thighs"/"thigh". "es" is only stripped after a sibilant (dishes→dish,
 * boxes→box); stripping it unconditionally turned "pickles" into "pickl",
 * which then failed to match "pickled".
 */
function stem(w: string): string {
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/**
 * True when the API's returned item name plausibly refers to the same thing
 * as the ingredient we asked about. Requires a shared meaningful word —
 * substring containment alone is what produced the peppercorn match.
 */
/**
 * Pairs that share a word but are emphatically different products. Stemming
 * is what makes these dangerous: it collapses "peppers" (the vegetable) into
 * "pepper" (the spice), so a token-overlap test happily matches 480g of bell
 * peppers to a 70g jar of peppercorns — the single worst mispricing found in
 * real data, at £27 for one line.
 */
const CONFLICTS: { ingredient: RegExp; sku: RegExp }[] = [
  { ingredient: /\bpeppers\b|bell pepper|mixed pepper/, sku: /peppercorn|black pepper|white pepper|ground pepper|cayenne/ },
  { ingredient: /\bmilk\b/, sku: /milkshake|chocolate drink/ },
  { ingredient: /\bsteaks?\b/, sku: /\bmince\b/ },
  { ingredient: /\bstock\b/, sku: /stockings?/ },
  { ingredient: /\bcream\b/, sku: /ice cream|cream soda/ },
];

export function matchesIngredient(itemName: string, ingredientName: string): boolean {
  const a = itemName.toLowerCase().trim();
  const b = ingredientName.toLowerCase().trim();

  for (const c of CONFLICTS) {
    if (c.ingredient.test(b) && c.sku.test(a)) return false;
  }

  if (a === b) return true;

  const aTokens = new Set(tokens(a).map(normalise));
  const bTokens = tokens(b).map(normalise);
  if (bTokens.length === 0 || aTokens.size === 0) {
    // Nothing meaningful to compare — fall back to exact-ish containment.
    return a.includes(b) || b.includes(a);
  }
  return bTokens.some((t) => aTokens.has(t));
}

/**
 * Sanity-checks the SKU we're about to price against. Same rule as above,
 * applied to the full product name rather than the API's item label — this
 * is what catches "scallops" → "Large Whole Chicken", where the item label
 * looked right but the product behind it didn't.
 */
export function isPlausibleProduct(skuName: string, ingredientName: string): boolean {
  return matchesIngredient(skuName, ingredientName);
}
