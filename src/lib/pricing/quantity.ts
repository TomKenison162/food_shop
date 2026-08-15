/**
 * Best-effort conversion of a recipe quantity string ("400g", "2 tbsp",
 * "1 clove", "to taste") into approximate grams, so a dish's marginal cost
 * can be prorated against the pack it came from.
 *
 * These are deliberately rough kitchen approximations, not a food-science
 * density table: 1 tbsp ~ 15g, 1 tsp ~ 5g, 1 ml ~ 1g. They only need to be
 * good enough to distinguish "this line uses a splash of a jar" from "this
 * line uses most of the pack" — the difference that keeps a 2 tbsp honey
 * line from being costed as a whole 340g jar.
 */
const GRAMS_PER_TBSP = 15;
const GRAMS_PER_TSP = 5;

/** Rough average weight of one "piece" of common piece-counted produce. */
const GRAMS_PER_PIECE_DEFAULT = 100;
const PIECE_GRAM_OVERRIDES: Record<string, number> = {
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
};

export interface ParsedQuantity {
  /** Approximate grams the recipe calls for; null when nothing sensible could be parsed. */
  grams: number | null;
  /** Discrete count, when the line is counted rather than weighed ("2", "6 thighs"). */
  pieces: number | null;
}

export function parseQuantityToGrams(qty: string): ParsedQuantity {
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

  // Unit-counted lines: "2 cloves", "1 handful", "6", "4 sprigs".
  const unitMatch = q.match(/(\d+(?:\.\d+)?)\s*([a-z]+)?/);
  if (unitMatch) {
    const count = parseFloat(unitMatch[1]);
    const unit = unitMatch[2];
    const perPiece = unit && unit in PIECE_GRAM_OVERRIDES ? PIECE_GRAM_OVERRIDES[unit] : GRAMS_PER_PIECE_DEFAULT;
    return { grams: count * perPiece, pieces: count };
  }

  // Bare unit words with no number ("handful of parsley").
  for (const [unit, grams] of Object.entries(PIECE_GRAM_OVERRIDES)) {
    if (q.includes(unit)) return { grams, pieces: 1 };
  }

  return { grams: null, pieces: null };
}
