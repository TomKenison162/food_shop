import "dotenv/config";
import { eq, isNotNull } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { meals, mealIngredients } from "../src/lib/db/schema";
import { computeQuantityCost } from "../src/lib/pricing/pepestoAdapter";
import { recomputeMealCosts } from "../src/lib/pricing/priceApproved";

/**
 * Re-derives every priced meal's costs from the pack price/size already
 * stored on each ingredient line — no pricing-API calls, no spend.
 *
 * Run this after changing any costing rule (piece weights, prorating,
 * tier thresholds) so existing data reflects the new logic instead of
 * being frozen at whatever the rules were when it was first priced.
 */
async function main() {
  const priced = await db.select().from(meals).where(isNotNull(meals.tier));
  let linesUpdated = 0;

  for (const meal of priced) {
    const ingredients = await db.query.mealIngredients.findMany({
      where: eq(mealIngredients.mealId, meal.id),
    });

    for (const ing of ingredients) {
      if (ing.packPrice === null) continue;

      const cost = computeQuantityCost(
        {
          skuName: ing.skuName ?? ing.genericName,
          pricePerPackGBP: Number(ing.packPrice),
          packQuantity: ing.packGrams !== null ? { grams: Number(ing.packGrams) } : { pieces: 1 },
        },
        ing.quantity,
        ing.genericName
      );

      await db
        .update(mealIngredients)
        .set({
          skuPrice: cost.firstShopPrice !== null ? String(cost.firstShopPrice) : ing.skuPrice,
          marginalPrice: cost.marginalPrice !== null ? String(cost.marginalPrice) : ing.marginalPrice,
          skuUnitSize: ing.isEstimated ? ing.skuUnitSize : cost.skuUnitSize,
          gramsPurchased: cost.gramsPurchased !== null ? String(cost.gramsPurchased) : null,
          gramsNeeded: cost.gramsNeeded !== null ? String(cost.gramsNeeded) : null,
        })
        .where(eq(mealIngredients.id, ing.id));

      ing.skuPrice = cost.firstShopPrice !== null ? String(cost.firstShopPrice) : ing.skuPrice;
      ing.marginalPrice = cost.marginalPrice !== null ? String(cost.marginalPrice) : ing.marginalPrice;
      linesUpdated++;
    }

    await recomputeMealCosts(meal.id, ingredients);
  }

  console.log(`Recomputed ${priced.length} meals (${linesUpdated} ingredient lines).`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
