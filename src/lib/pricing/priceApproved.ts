import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { approvedQueue, meals, mealIngredients } from "../db/schema";
import { tierForCost } from "../tiering";
import { getPricingAdapter } from "./adapter";
import { recordPurchaseLeftovers } from "../pantry/pantry";

const MIN_MATCH_RATIO = 0.7; // require most ingredient lines priced before trusting a meal's total

export interface PriceApprovedResult {
  pricedMealIds: number[];
  stillUnpriced: { mealId: number; mealName: string; missingIngredients: string[] }[];
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
 * from the DB at zero extra cost. A meal is priced from whatever matched;
 * it needs at least MIN_MATCH_RATIO of its lines resolved to get a
 * trustworthy total, otherwise it's left unpriced rather than silently
 * understating cost — see stillUnpriced in the result. Re-running this
 * function is exactly how those get a second attempt.
 */
export async function priceApprovedMeals(): Promise<PriceApprovedResult> {
  const adapter = getPricingAdapter();

  const unpriced = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(isNull(meals.tier));

  if (unpriced.length === 0) {
    return { pricedMealIds: [], stillUnpriced: [], uniqueIngredientsRequested: 0 };
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
  const stillUnpriced: PriceApprovedResult["stillUnpriced"] = [];

  for (const { meal } of unpriced) {
    const ingredients = ingredientsByMeal.get(meal.id) ?? [];
    if (ingredients.length === 0) continue;

    // Resolve newly-matched ingredients and write them back individually.
    // Only these (not ones reused from a prior run — grams weren't
    // persisted for those) can feed pantry leftover tracking this pass.
    const newlyResolved: { name: string; gramsPurchased: number | null; gramsNeeded: number | null }[] = [];
    for (const ing of ingredients) {
      if (ing.skuPrice !== null) continue; // already priced from a prior run
      const cost = adapter.costForQuantity(matches.get(ing.genericName) ?? null, ing.quantity);
      if (cost.skuPrice === null) continue;
      await db
        .update(mealIngredients)
        .set({ skuName: cost.skuName, skuPrice: String(cost.skuPrice), skuUnitSize: cost.skuUnitSize })
        .where(eq(mealIngredients.id, ing.id));
      ing.skuName = cost.skuName;
      ing.skuPrice = String(cost.skuPrice);
      ing.skuUnitSize = cost.skuUnitSize;
      newlyResolved.push({
        name: ing.genericName,
        gramsPurchased: cost.gramsPurchased,
        gramsNeeded: cost.gramsNeeded,
      });
    }

    const pricedCount = ingredients.filter((i) => i.skuPrice !== null).length;
    const matchRatio = pricedCount / ingredients.length;

    if (matchRatio < MIN_MATCH_RATIO) {
      stillUnpriced.push({
        mealId: meal.id,
        mealName: meal.name,
        missingIngredients: ingredients.filter((i) => i.skuPrice === null).map((i) => i.genericName),
      });
      continue;
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

    if (newlyResolved.length > 0) {
      await recordPurchaseLeftovers(meal.id, newlyResolved);
    }
    pricedMealIds.push(meal.id);
  }

  return { pricedMealIds, stillUnpriced, uniqueIngredientsRequested: namesNeedingMatch.size };
}
