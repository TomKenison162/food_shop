/**
 * Pure budget rules — deliberately free of database imports so the
 * selection logic that depends on them stays unit-testable. The query side
 * lives in budgetSpend.ts.
 */
export const WEEKLY_BUDGET_GBP = 100;

/**
 * The cost a meal contributes to the weekly budget: its MARGINAL cost (what
 * cooking it actually consumes), not the first-shop whole-pack total —
 * budgeting against first-shop cost would double-count staples you already
 * own every single time they appear in a recipe.
 */
export function costForPortions(
  meal: { costMarginalOnePerson: string | null; costMarginalTwoPerson: string | null },
  portions: 1 | 2
): number | null {
  const raw = portions === 1 ? meal.costMarginalOnePerson : meal.costMarginalTwoPerson;
  return raw !== null ? Number(raw) : null;
}

/** First-shop total to display on the shopping list, for the chosen portion size. */
export function firstShopCostForPortions(
  meal: { costFirstShopOnePerson: string | null; costFirstShopTwoPerson: string | null },
  portions: 1 | 2
): number | null {
  const raw = portions === 1 ? meal.costFirstShopOnePerson : meal.costFirstShopTwoPerson;
  return raw !== null ? Number(raw) : null;
}
