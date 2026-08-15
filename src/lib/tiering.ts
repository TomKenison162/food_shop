export type Tier = "budget" | "standard" | "gourmet";

// GBP per-portion thresholds. Tune these as real pricing data comes online.
const BUDGET_MAX = 2.5;
const STANDARD_MAX = 5.0;

/**
 * Tiers a meal from its 2-person cost per portion. Returns null if the meal
 * isn't fully priced yet (any ingredient missing an sku price) — unpriced
 * meals are excluded from the live app's tier filter until priced.
 */
export function tierForCost(costTwoPerson: number | null): Tier | null {
  if (costTwoPerson === null) return null;
  const perPortion = costTwoPerson / 2;
  if (perPortion <= BUDGET_MAX) return "budget";
  if (perPortion <= STANDARD_MAX) return "standard";
  return "gourmet";
}
