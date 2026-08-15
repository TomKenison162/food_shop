import { WEEKLY_BUDGET_GBP } from "./budget";

export type Tier = "budget" | "standard" | "gourmet";

/**
 * Tiers a meal from its MARGINAL 2-person cost (what cooking it actually
 * consumes), relative to WEEKLY_BUDGET_GBP rather than fixed GBP amounts —
 * a static "£5 = standard" threshold means nothing without knowing the
 * budget. The baseline is one day's share of the weekly budget for a
 * 2-person dinner (WEEKLY_BUDGET_GBP / 7): at or under half of that is
 * "budget", up to the full share is "standard", above it is "gourmet".
 *
 * Marginal (not first-shop) cost is deliberate: tiering on first-shop cost
 * made every dish look "gourmet" because each one notionally bought its own
 * bottle of oil and jar of spices.
 */
const DAILY_ALLOWANCE_TWO_PERSON = WEEKLY_BUDGET_GBP / 7;
const BUDGET_MAX = DAILY_ALLOWANCE_TWO_PERSON * 0.5;
const STANDARD_MAX = DAILY_ALLOWANCE_TWO_PERSON;

/**
 * Returns null if the meal isn't priced yet — unpriced meals are excluded
 * from the live app's tier filter until priced.
 */
export function tierForCost(marginalCostTwoPerson: number | null): Tier | null {
  if (marginalCostTwoPerson === null) return null;
  if (marginalCostTwoPerson <= BUDGET_MAX) return "budget";
  if (marginalCostTwoPerson <= STANDARD_MAX) return "standard";
  return "gourmet";
}
