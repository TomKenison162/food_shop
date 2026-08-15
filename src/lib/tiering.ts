import { WEEKLY_BUDGET_GBP } from "./budget";

export type Tier = "budget" | "standard" | "gourmet";

/**
 * Tiers a meal from its 2-person cost, relative to WEEKLY_BUDGET_GBP rather
 * than fixed GBP amounts — a static "£5 = standard" threshold doesn't mean
 * anything without knowing what the actual weekly budget is. The baseline
 * is one day's share of the weekly budget for a 2-person dinner
 * (WEEKLY_BUDGET_GBP / 7): at or under half of that is "budget", up to that
 * full share is "standard", above it is "gourmet". Recompute all meals'
 * tiers (see scripts/_recompute-tiers pattern) if WEEKLY_BUDGET_GBP changes.
 */
const DAILY_ALLOWANCE_TWO_PERSON = WEEKLY_BUDGET_GBP / 7;
const BUDGET_MAX = DAILY_ALLOWANCE_TWO_PERSON * 0.5;
const STANDARD_MAX = DAILY_ALLOWANCE_TWO_PERSON;

/**
 * Returns null if the meal isn't fully priced yet — unpriced meals are
 * excluded from the live app's tier filter until priced.
 */
export function tierForCost(costTwoPerson: number | null): Tier | null {
  if (costTwoPerson === null) return null;
  if (costTwoPerson <= BUDGET_MAX) return "budget";
  if (costTwoPerson <= STANDARD_MAX) return "standard";
  return "gourmet";
}
