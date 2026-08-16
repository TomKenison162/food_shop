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

  // The fruit is not the leaf. "2 limes" matched "Fresh Packed Lime Leaves
  // 4 Pack" on the shared token, and since a leaf weighs ~1g the quantity
  // maths then demanded eight packs: £16 of lime leaves for two limes.
  // ...unless the recipe genuinely wants the leaf: "kaffir lime leaves"
  // shares the token but is a different ingredient, correctly matched.
  { ingredient: /^(?!.*(leaf|leaves|kaffir)).*\blimes?\b/, sku: /lime leaf|lime leaves|kaffir/ },
  { ingredient: /\blemons?\b/, sku: /lemon ?grass|lemon balm|lemonade/ },

  // Wine colour is not negotiable in a braise. "red wine" matched a
  // Sauvignon Blanc purely on the token "wine".
  { ingredient: /\bred wine\b/, sku: /white wine|sauvignon|pinot grigio|chardonnay|prosecco|ros[ée]/ },
  { ingredient: /\bwhite wine\b/, sku: /red wine|merlot|shiraz|malbec|rioja|cabernet/ },

  // Cooking stock, not a finished bowl of soup — "chicken stock" matched an
  // Itsu ramen broth at £2.70 per 500ml, so 1.2L cost £8.10 instead of pence.
  { ingredient: /\bstock\b/, sku: /ramen|noodle|soup|cup a soup|broth bowl/ },

  // Cut matters, both for price and for the recipe. Sirloin is not diced
  // stewing beef; a shoulder joint is not a pack of grill steaks.
  { ingredient: /\bsirloin|rump|skirt|fillet steak|steaks?\b/, sku: /\bdiced\b|stewing|casserole/ },
  { ingredient: /shoulder|\bjoint\b|whole \w+/, sku: /grill steaks?|\bchops?\b|\bmince\b|\bdiced\b/ },
  { ingredient: /\bmince\b/, sku: /\bdiced\b|\bsteaks?\b|\bjoint\b/ },
  { ingredient: /\bbreasts?\b/, sku: /\blegs?\b|\bthighs?\b|\bwings?\b|\bdrumsticks?\b/ },
  { ingredient: /\blegs?\b|\bthighs?\b/, sku: /\bbreasts?\b/ },

  // Prepared form matters as much as the ingredient. Ground spice is not
  // whole seed (and cost 3x as much when swapped), and oil spray is not
  // cooking oil.
  { ingredient: /\bground \w+/, sku: /\bseeds?\b|\bwhole\b|\bsticks?\b|\bpods?\b/ },
  { ingredient: /\bseeds?\b|\bsticks?\b/, sku: /\bground\b|\bpowder\b/ },
  { ingredient: /\boils?\b/, sku: /spray|air fryer/ },

  // A juice ingredient needs an actual juice, not the fruit it comes from.
  { ingredient: /\bjuice\b/, sku: /^(?!.*\bjuice\b).*$/ },

  // Fresh vs preserved/processed forms price completely differently.
  // The whole fruit is not its juice. The lookahead has to guard the entire
  // alternation: written as `^(?!...)...\blimes?\b|\blemons?\b|...` the
  // negation only bound to the first branch, so "orange juice" was rejected
  // from matching orange juice.
  {
    ingredient: /^(?!.*\bjuice\b)(?=.*(\blimes?\b|\blemons?\b|\boranges?\b))/,
    sku: /\bjuice\b|squash|cordial/,
  },
];

/**
 * Premium ranges cost multiples of the standard line for the same
 * ingredient. Left unranked, whichever the API happened to return first
 * won — which is how a 500g pack of organic diced beef became the match for
 * plain "beef sirloin" in five separate dishes.
 */
const PREMIUM_MARKERS =
  /\borganic\b|taste the difference|finest|luxury|free range|\bpremium\b|specially selected|artisan|\bwagyu\b|\baged\b/;

/**
 * How well a product name answers an ingredient, higher is better.
 *
 * Used to *rank* plausible candidates rather than take the first one the API
 * returned. Three things decide it: how much of the ingredient name is
 * actually present, whether the product is from a premium range, and how
 * much unrelated wording it carries (a long name usually means a prepared
 * product rather than the raw ingredient).
 */
export function scoreProductMatch(skuName: string, ingredientName: string): number {
  const a = skuName.toLowerCase().trim();
  const b = ingredientName.toLowerCase().trim();

  const skuTokens = new Set(tokens(a).map(normalise));
  const ingTokens = tokens(b).map(normalise);
  if (ingTokens.length === 0) return 0;

  const covered = ingTokens.filter((t) => skuTokens.has(t)).length;
  let score = covered / ingTokens.length; // 0..1, how much of the ingredient is present

  if (a.includes(b)) score += 0.5; // the whole ingredient name appears verbatim
  if (PREMIUM_MARKERS.test(a)) score -= 0.4;

  // Every extra word beyond the ingredient is a small signal of a prepared
  // or flavoured product ("Chicken & Bacon Pasta Bake" for "chicken").
  score -= Math.max(0, skuTokens.size - ingTokens.length) * 0.02;

  return score;
}


/**
 * Meat is where token overlap fails hardest, because the animal name is
 * usually the only shared word and it says nothing about what you're
 * buying. Real matches this produced: "pork shoulder" to Richmond Thick
 * Pork Sausages, "beef sirloin" to 5% Fat Beef Mince, "duck legs" to Duck
 * Livers, "whole chicken" to a carton of ramen broth, and "diced venison
 * shoulder" to a lamb joint.
 *
 * Two independent checks, both of which must pass:
 *  1. same animal
 *  2. compatible cut, when both sides name one
 */
const ANIMALS: { name: string; re: RegExp }[] = [
  { name: "beef", re: /\bbeef\b|\bveal\b|\bsteak\b|\bbrisket\b/ },
  { name: "pork", re: /\bpork\b|\bgammon\b|\bham\b|\bbacon\b|\bchorizo\b|\bpancetta\b/ },
  { name: "lamb", re: /\blamb\b|\bmutton\b|\bmerguez\b/ },
  { name: "chicken", re: /\bchicken\b|\bpoultry\b/ },
  { name: "duck", re: /\bduck\b/ },
  { name: "turkey", re: /\bturkey\b/ },
  { name: "venison", re: /\bvenison\b/ },
  // Listed separately rather than as one "seafood" bucket, or cod would
  // happily match salmon on a shared category.
  { name: "prawn", re: /\bprawns?\b|\bshrimps?\b/ },
  { name: "scallop", re: /\bscallops?\b/ },
  { name: "mussel", re: /\bmussels?\b/ },
  { name: "salmon", re: /\bsalmon\b/ },
  { name: "cod", re: /\bcod\b/ },
  { name: "fish", re: /\bfish\b|\bhaddock\b|\btuna\b/ },
];

/**
 * Cut families. Anything that resolves to two different families is a
 * different product, however similar the words look.
 */
const CUTS: { name: string; re: RegExp }[] = [
  { name: "stock", re: /\bstock\b|\bbroth\b|\bbouillon\b|stock pot|stock cube/ },
  { name: "offal", re: /\blivers?\b|\bkidneys?\b|\bhearts?\b|\boffal\b|\bpate\b/ },
  { name: "sausage", re: /\bsausages?\b|chipolata|frankfurter|\bmerguez\b/ },
  { name: "mince", re: /\bminced?\b|\bburgers?\b|\bmeatballs?\b/ },
  { name: "diced", re: /\bdiced\b|\bstewing\b|\bcasserole\b|\bchunks\b|\bcubed\b/ },
  { name: "strips", re: /stir fry|\bstrips\b/ },
  { name: "steak", re: /\bsteaks?\b|\bsirloin\b|\brump\b|\bmedallions?\b|\bskirt\b|\bribeye\b|\bfillet steak\b/ },
  { name: "chop", re: /\bchops?\b|\bcutlets?\b/ },
  { name: "ribs", re: /\bribs?\b/ },
  { name: "belly", re: /\bbelly\b/ },
  { name: "wing", re: /\bwings?\b/ },
  { name: "thigh", re: /\bthighs?\b|\bdrumsticks?\b/ },
  { name: "breast", re: /\bbreasts?\b/ },
  { name: "shank", re: /\bshanks?\b/ },
  { name: "tenderloin", re: /\btenderloins?\b/ },
  { name: "joint", re: /\bjoints?\b|\bshoulders?\b|\bshin\b|\brolled\b|\blegs?\b/ },
  { name: "whole", re: /\bwhole\b.*\b(chicken|duck|bird)\b|\b(chicken|duck)\b.*\bwhole\b/ },
  { name: "fillet", re: /\bfillets?\b/ },
];

/**
 * Raw meat wants raw meat. A recipe asking for chicken breasts does not
 * want Cajun Chicken Breast Grills, and king prawns are not battered
 * prawns, but both share every meaningful token.
 */
const PREPARED =
  /battered|breaded|crispy|goujons?|nuggets?|kievs?|marinated|seasoned|\bgrills?\b|cajun|bbq |barbecue|tikka|peri|southern fried|dippers?|\bcoated\b|\bin sauce\b|\bpickled\b|\bsmoked\b|\bcured\b|\bin brine\b/;

/** The cut a name declares, or null if it names none. */
export function cutOf(text: string): string | null {
  return classify(text.toLowerCase(), CUTS);
}

function classify(text: string, table: { name: string; re: RegExp }[]): string | null {
  for (const entry of table) {
    if (entry.re.test(text)) return entry.name;
  }
  return null;
}

/**
 * True when a SKU is an acceptable cut of the right animal for a meat
 * ingredient. Non-meat ingredients pass straight through.
 */
export function meatMatches(skuName: string, ingredientName: string): boolean {
  const sku = skuName.toLowerCase();
  const ing = ingredientName.toLowerCase();

  const ingAnimal = classify(ing, ANIMALS);
  if (ingAnimal === null) return true; // not a meat line; nothing to check

  // The SKU must name the same animal. "diced venison shoulder" matched a
  // lamb joint on the shared word "shoulder" alone.
  const animal = ANIMALS.find((a) => a.name === ingAnimal)!;
  if (!animal.re.test(sku)) return false;

  const skuAnimal = classify(sku, ANIMALS);
  if (skuAnimal !== null && skuAnimal !== ingAnimal && !animal.re.test(sku)) return false;

  if (PREPARED.test(sku) && !PREPARED.test(ing)) return false;

  const ingCut = classify(ing, CUTS);
  const skuCut = classify(sku, CUTS);

  // A bare "chicken" ingredient should still accept thighs or breasts.
  if (ingCut === null) return true;

  // But when the recipe does name a cut, a product that names none is not a
  // substitute for it. "Quick Cook Extra Thin Beef" declares nothing, so it
  // satisfied beef sirloin, beef fillet and beef short ribs alike, and being
  // the cheapest it won all three. An honest flagged estimate beats a cut
  // that is silently wrong and priced like something else.
  if (skuCut === null) return false;

  return ingCut === skuCut;
}

export function matchesIngredient(itemName: string, ingredientName: string): boolean {
  const a = itemName.toLowerCase().trim();
  const b = ingredientName.toLowerCase().trim();

  for (const c of CONFLICTS) {
    if (c.ingredient.test(b) && c.sku.test(a)) return false;
  }

  if (!meatMatches(a, b)) return false;

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
