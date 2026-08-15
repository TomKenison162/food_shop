/**
 * Best-effort conversion of a recipe quantity string ("400g", "2 tbsp",
 * "1 clove", "2 sirloin steaks") into approximate grams, so a dish's
 * marginal cost can be prorated against the pack it came from.
 *
 * These are deliberately rough kitchen approximations, not a food-science
 * density table: 1 tbsp ~ 15g, 1 tsp ~ 5g, 1 ml ~ 1g. They only need to be
 * good enough to distinguish "this line uses a splash of a jar" from "this
 * line uses most of the pack".
 */
const GRAMS_PER_TBSP = 15;
const GRAMS_PER_TSP = 5;

/** Weight of one piece, keyed by the unit word in the quantity string. */
const UNIT_GRAMS: Record<string, number> = {
  clove: 5,
  cloves: 5,
  sprig: 2,
  sprigs: 2,
  leaf: 5,
  leaves: 5,
  slice: 25,
  slices: 25,
  handful: 30,
  bunch: 50,
  pinch: 1,
  stalk: 15,
  stalks: 15,
  bulb: 60,
  tin: 400,
  tins: 400,
  can: 400,
  cans: 400,
  packet: 100,
  packets: 100,
};

/**
 * Weight of one piece, keyed by the INGREDIENT name — for lines like
 * "2" / "6" where the quantity carries no unit at all and only the
 * ingredient tells you how heavy a piece is.
 *
 * This matters more than it looks: a flat 100g-per-piece default costed
 * "2 sirloin steaks" as 200g, roughly a quarter of the truth, which fed
 * straight into meal tiering and the weekly budget and made expensive cuts
 * look cheap. Matched longest-key-first so "chicken breast" wins over
 * "chicken".
 */
const INGREDIENT_PIECE_GRAMS: Record<string, number> = {
  // meat & fish, by cut
  "sirloin steak": 225,
  "beef fillet": 200,
  steak: 225,
  "lamb shoulder": 1500,
  "lamb chop": 120,
  "lamb leg steak": 180,
  "pork chop": 180,
  "pork loin steak": 180,
  "pork belly slice": 80,
  "chicken thigh": 150,
  "chicken breast": 180,
  "duck breast": 200,
  "duck leg": 200,
  "whole chicken": 1500,
  "fish fillet": 140,
  "cod fillet": 140,
  "salmon fillet": 130,
  scallop: 20,
  prawn: 10,
  // bakery
  "bao bun": 70,
  "brioche bun": 60,
  "burger bun": 60,
  bun: 60,
  "lasagne sheet": 12,
  "taco shell": 13,
  tortilla: 45,
  wrap: 45,
  flatbread: 80,
  pitta: 65,
  naan: 90,
  "chinese pancake": 12,
  crouton: 2,
  // produce
  onion: 150,
  shallot: 30,
  garlic: 60,
  carrot: 80,
  potato: 180,
  pepper: 160,
  aubergine: 250,
  cucumber: 300,
  lemon: 100,
  lime: 70,
  orange: 150,
  apple: 150,
  "pak choi": 120,
  "corn on the cob": 200,
  lettuce: 300,
  cabbage: 900,
  egg: 55,
};

const GRAMS_PER_PIECE_DEFAULT = 120;

export interface ParsedQuantity {
  /** Approximate grams the recipe calls for; null when nothing sensible could be parsed. */
  grams: number | null;
  /** Discrete count, when the line is counted rather than weighed ("2", "6 thighs"). */
  pieces: number | null;
}

/** Grams for a single piece of `ingredientName`, using the longest matching key. */
export function gramsPerPiece(ingredientName?: string): number {
  if (!ingredientName) return GRAMS_PER_PIECE_DEFAULT;
  const name = ingredientName.toLowerCase();

  // The unit is often carried by the ingredient name rather than the
  // quantity — "bay leaves" with quantity "2" means two leaves, not two
  // generic pieces. Missing this costed 2 bay leaves as 240g, which at a
  // 3g pack size came out as 80 packs and £88 for a garnish.
  let unitBest: { key: string; grams: number } | null = null;
  for (const [key, grams] of Object.entries(UNIT_GRAMS)) {
    if (name.includes(key) && (unitBest === null || key.length > unitBest.key.length)) {
      unitBest = { key, grams };
    }
  }

  let best: { key: string; grams: number } | null = null;
  for (const [key, grams] of Object.entries(INGREDIENT_PIECE_GRAMS)) {
    // Match singular key against a possibly-plural ingredient name.
    if (name.includes(key) && (best === null || key.length > best.key.length)) {
      best = { key, grams };
    }
  }

  // A specific ingredient match ("chicken thigh") beats a generic unit word;
  // otherwise the unit word beats the blanket default.
  if (best && unitBest) return best.key.length >= unitBest.key.length ? best.grams : unitBest.grams;
  return best?.grams ?? unitBest?.grams ?? GRAMS_PER_PIECE_DEFAULT;
}

/**
 * `ingredientName` is optional but strongly recommended: without it,
 * unit-less counted lines ("2", "6") fall back to a generic per-piece
 * weight and can be badly wrong for heavy cuts.
 */
export function parseQuantityToGrams(qty: string, ingredientName?: string): ParsedQuantity {
  const q = qty.toLowerCase().trim();

  // "to taste" / "a pinch" — negligible, but not zero.
  if (/to taste|a pinch|as needed|optional/.test(q)) {
    return { grams: 1, pieces: null };
  }

  const num = (m: RegExpMatchArray | null) => (m ? parseFloat(m[1]) : null);

  const kg = num(q.match(/(\d+(?:\.\d+)?)\s*kg/));
  if (kg !== null) return { grams: kg * 1000, pieces: null };

  const litres = num(q.match(/(\d+(?:\.\d+)?)\s*(?:l|litre|liter)\b/));
  if (litres !== null) return { grams: litres * 1000, pieces: null };

  const ml = num(q.match(/(\d+(?:\.\d+)?)\s*ml/));
  if (ml !== null) return { grams: ml, pieces: null };

  const g = num(q.match(/(\d+(?:\.\d+)?)\s*g\b/));
  if (g !== null) return { grams: g, pieces: null };

  const tbsp = num(q.match(/(\d+(?:\.\d+)?)\s*(?:tbsp|tablespoon)/));
  if (tbsp !== null) return { grams: tbsp * GRAMS_PER_TBSP, pieces: null };

  const tsp = num(q.match(/(\d+(?:\.\d+)?)\s*(?:tsp|teaspoon)/));
  if (tsp !== null) return { grams: tsp * GRAMS_PER_TSP, pieces: null };

  // Counted lines: "2 cloves", "1 handful", "6", "4 sprigs".
  const unitMatch = q.match(/(\d+(?:\.\d+)?)\s*([a-z]+)?/);
  if (unitMatch) {
    const count = parseFloat(unitMatch[1]);
    const unit = unitMatch[2];
    // An explicit unit word wins; otherwise fall back to what a piece of
    // this particular ingredient weighs.
    const perPiece = unit && unit in UNIT_GRAMS ? UNIT_GRAMS[unit] : gramsPerPiece(ingredientName);
    return { grams: count * perPiece, pieces: count };
  }

  // Bare unit words with no number ("handful of parsley").
  for (const [unit, grams] of Object.entries(UNIT_GRAMS)) {
    if (q.includes(unit)) return { grams, pieces: 1 };
  }

  return { grams: null, pieces: null };
}
