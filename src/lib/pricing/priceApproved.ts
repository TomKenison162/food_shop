import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { approvedQueue, meals, mealIngredients } from "../db/schema";
import { tierForCost } from "../tiering";
import { getPricingAdapter } from "./adapter";
import { estimateIngredientPriceGBP } from "./estimates";

export interface PriceApprovedResult {
  pricedMealIds: number[];
  estimatedIngredientCount: number;
  uniqueIngredientsRequested: number;
}

/**
 * Prices every approved-but-not-yet-priced meal — the sole place real
 * pricing-API spend happens, only when explicitly invoked (npm run
 * pipeline:price, or the equivalent admin API route). Never called
 * automatically by recipe generation or the swipe deck.
 *
 * Only ingredient NAMES with no existing match anywhere are sent to the
 * adapter — already-resolved ones (from a prior run) are reused straight
 * from the DB at zero extra cost. Anything Pepesto still can't match gets a
 * hand-judged estimate (src/lib/pricing/estimates.ts) instead of being left
 * unpriced, so every meal gets a real total — those lines are flagged
 * (isEstimated) and called out explicitly in the shopping-list email.
 */
export async function priceApprovedMeals(): Promise<PriceApprovedResult> {
  const adapter = getPricingAdapter();

  const unpriced = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(isNull(meals.tier));

  if (unpriced.length === 0) {
    return { pricedMealIds: [], estimatedIngredientCount: 0, uniqueIngredientsRequested: 0 };
  }

  const ingredientsByMeal = new Map<number, (typeof mealIngredients.$inferSelect)[]>();
  const namesNeedingMatch = new Set<string>();

  for (const { meal } of unpriced) {
    const ingredients = await db.query.mealIngredients.findMany({
      where: eq(mealIngredients.mealId, meal.id),
    });
    ingredientsByMeal.set(meal.id, ingredients);
    for (const ing of ingredients) {
      if (ing.skuPrice === null) namesNeedingMatch.add(ing.genericName);
    }
  }

  const matches = await adapter.matchProducts([...namesNeedingMatch]);

  const pricedMealIds: number[] = [];
  let estimatedIngredientCount = 0;

  for (const { meal } of unpriced) {
    const ingredients = ingredientsByMeal.get(meal.id) ?? [];
    if (ingredients.length === 0) continue;

    // Resolve newly-matched ingredients and write them back individually.
    // gramsPurchased/gramsNeeded are persisted (not acted on here) so
    // pantry leftovers can be recorded later at serve time — see
    // recordPurchaseLeftoversForMeal in rotation.ts. Pricing the whole
    // approved queue isn't 51 real shopping trips; only actually serving a
    // meal is.
    for (const ing of ingredients) {
      if (ing.skuPrice !== null) continue; // already priced from a prior run
      const cost = adapter.costForQuantity(matches.get(ing.genericName) ?? null, ing.quantity);

      if (cost.skuPrice !== null) {
        await db
          .update(mealIngredients)
          .set({
            skuName: cost.skuName,
            skuPrice: String(cost.skuPrice),
            skuUnitSize: cost.skuUnitSize,
            gramsPurchased: cost.gramsPurchased !== null ? String(cost.gramsPurchased) : null,
            gramsNeeded: cost.gramsNeeded !== null ? String(cost.gramsNeeded) : null,
            isEstimated: false,
          })
          .where(eq(mealIngredients.id, ing.id));
        ing.skuPrice = String(cost.skuPrice);
      } else {
        // Pepesto had no match at all — fall back to a flagged estimate
        // rather than leaving this meal's total incomplete.
        const estimate = estimateIngredientPriceGBP(ing.genericName);
        await db
          .update(mealIngredients)
          .set({
            skuName: null,
            skuPrice: String(estimate),
            skuUnitSize: "estimated, not from Sainsbury's",
            isEstimated: true,
          })
          .where(eq(mealIngredients.id, ing.id));
        ing.skuPrice = String(estimate);
        estimatedIngredientCount++;
      }
    }

    const costTwoPerson = ingredients.reduce((sum, i) => sum + (i.skuPrice !== null ? Number(i.skuPrice) : 0), 0);
    const costOnePerson = Math.round((costTwoPerson / 2) * 100) / 100;
    const tier = tierForCost(costTwoPerson);

    await db
      .update(meals)
      .set({
        costOnePerson: String(costOnePerson),
        costTwoPerson: String(costTwoPerson),
        tier: tier ?? undefined,
      })
      .where(eq(meals.id, meal.id));

    pricedMealIds.push(meal.id);
  }

  return { pricedMealIds, estimatedIngredientCount, uniqueIngredientsRequested: namesNeedingMatch.size };
}
