/**
 * Fallback price estimates for ingredients Pepesto had no product match
 * for, so every approved meal ends up with a real total instead of staying
 * permanently unpriced over a handful of missing lines. These are hand-
 * judged, realistic UK supermarket ballpark prices (Sainsbury's-level, not
 * premium) for the quantity a typical recipe line calls for — NOT live
 * data. Every estimated line is flagged (mealIngredients.isEstimated) and
 * called out explicitly in the shopping-list email; never silently treated
 * as a real price.
 */
const KNOWN_ESTIMATES: Record<string, number> = {
  "chicken thighs": 3.5,
  "chicken stock": 0.8,
  "naan bread": 1.2,
  "diced beef shin": 5.5,
  mirin: 2.2,
  "spring onion": 0.65,
  "whole chicken": 5.5,
  "diced beef": 5.0,
  "caesar dressing": 1.8,
  "pork belly slices": 3.8,
  "pork chops": 4.0,
  "pork tenderloin": 4.5,
  "lamb leg": 8.5,
  "burger buns": 1.2,
  "diced beef chuck": 5.5,
  "pearl onions": 1.5,
  "red onion": 0.35,
  buttermilk: 1.0,
  "five spice": 1.2,
  "lamb leg steaks": 6.5,
  paprika: 1.0,
  "chilli powder": 1.0,
  "lamb chops": 7.0,
  "duck breasts": 6.5,
  "paella rice": 2.2,
  saffron: 3.5,
  scallops: 8.0,
};

interface KeywordRule {
  keywords: string[];
  price: number;
}

// Ordered most-specific first; the first matching category wins.
const KEYWORD_FALLBACKS: KeywordRule[] = [
  { keywords: ["scallop", "prawn", "salmon", "cod", "fish", "mussel", "seafood"], price: 6.0 },
  { keywords: ["beef", "lamb", "duck", "venison", "steak"], price: 6.0 },
  { keywords: ["chicken", "pork", "turkey", "bacon", "sausage", "mince"], price: 4.0 },
  { keywords: ["cheese", "cream", "butter", "milk", "yoghurt", "paneer", "halloumi"], price: 1.8 },
  { keywords: ["spice", "powder", "paprika", "cumin", "herb", "seasoning", "chilli"], price: 1.2 },
  { keywords: ["sauce", "paste", "dressing", "stock", "hoisin", "mustard"], price: 1.8 },
  { keywords: ["rice", "pasta", "noodle", "bread", "flour", "couscous"], price: 1.5 },
];

const GENERIC_FALLBACK = 2.0;

export function estimateIngredientPriceGBP(genericName: string): number {
  const name = genericName.toLowerCase().trim();
  if (name in KNOWN_ESTIMATES) return KNOWN_ESTIMATES[name];

  for (const rule of KEYWORD_FALLBACKS) {
    if (rule.keywords.some((kw) => name.includes(kw))) return rule.price;
  }

  return GENERIC_FALLBACK;
}
