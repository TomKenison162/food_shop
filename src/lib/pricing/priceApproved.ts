import { eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { approvedQueue, meals, mealIngredients } from "../db/schema";
import { tierForCost } from "../tiering";
import { getPricingAdapter } from "./adapter";
import { recordPurchaseLeftovers } from "../pantry/pantry";

export interface PriceApprovedResult {
  pricedMealIds: number[];
}

/**
 * Prices every approved-but-not-yet-priced meal, and only those meals —
 * this is the sole place real pricing-API spend happens, and it only
 * happens when explicitly invoked (npm run pipeline:price, or the
 * equivalent admin API route). Never called automatically by recipe
 * generation or by the swipe deck.
 */
export async function priceApprovedMeals(): Promise<PriceApprovedResult> {
  const adapter = getPricingAdapter();

  const unpriced = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(isNull(meals.tier));

  const pricedMealIds: number[] = [];

  for (const { meal } of unpriced) {
    const ingredients = await db.query.mealIngredients.findMany({
      where: eq(mealIngredients.mealId, meal.id),
    });
    if (ingredients.length === 0) continue;

    const priced = await adapter.price(
      ingredients.map((i) => ({ name: i.genericName, quantity: i.quantity }))
    );

    const allPriced = priced.every((p) => p.skuPrice !== null);
    const costTwoPerson = allPriced
      ? priced.reduce((sum, p) => sum + (p.skuPrice as number), 0)
      : null;
    const costOnePerson = costTwoPerson !== null ? Math.round((costTwoPerson / 2) * 100) / 100 : null;
    const tier = tierForCost(costTwoPerson);

    await db
      .update(meals)
      .set({
        costOnePerson: costOnePerson !== null ? String(costOnePerson) : null,
        costTwoPerson: costTwoPerson !== null ? String(costTwoPerson) : null,
        tier: tier ?? undefined,
      })
      .where(eq(meals.id, meal.id));

    for (const p of priced) {
      const original = ingredients.find((i) => i.genericName === p.name);
      if (!original) continue;
      await db
        .update(mealIngredients)
        .set({
          skuName: p.skuName,
          skuPrice: p.skuPrice !== null ? String(p.skuPrice) : null,
          skuUnitSize: p.skuUnitSize,
        })
        .where(eq(mealIngredients.id, original.id));
    }

    await recordPurchaseLeftovers(meal.id, priced);
    pricedMealIds.push(meal.id);
  }

  return { pricedMealIds };
}
