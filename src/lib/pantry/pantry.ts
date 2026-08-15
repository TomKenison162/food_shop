import { and, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { pantryItems, mealIngredients } from "../db/schema";
import type { PricedIngredient } from "../pricing/adapter";

const MIN_LEFTOVER_GRAMS = 20; // ignore trivial scraps

/**
 * Records leftover stock from a meal's priced ingredients — e.g. a recipe
 * needs 400g chicken thighs but the matched pack was 500g: 100g leftover.
 * Called once, right after priceApprovedMeals prices a meal.
 */
export async function recordPurchaseLeftovers(mealId: number, priced: PricedIngredient[]): Promise<void> {
  for (const ing of priced) {
    if (ing.gramsPurchased === null || ing.gramsNeeded === null) continue;
    const leftover = ing.gramsPurchased - ing.gramsNeeded;
    if (leftover < MIN_LEFTOVER_GRAMS) continue;

    const existing = await db.query.pantryItems.findFirst({
      where: eq(pantryItems.genericName, ing.name),
    });

    if (existing) {
      await db
        .update(pantryItems)
        .set({
          gramsRemaining: String(Number(existing.gramsRemaining) + leftover),
          sourceMealId: mealId,
          updatedAt: new Date(),
        })
        .where(eq(pantryItems.id, existing.id));
    } else {
      await db.insert(pantryItems).values({
        genericName: ing.name,
        gramsRemaining: String(leftover),
        sourceMealId: mealId,
      });
    }
  }
}

/**
 * Deducts pantry stock consumed by a meal actually served tonight, so
 * leftovers run down as they get used up rather than being counted forever.
 */
export async function consumePantryForMeal(mealId: number): Promise<void> {
  const ingredients = await db.query.mealIngredients.findMany({
    where: eq(mealIngredients.mealId, mealId),
  });

  for (const ing of ingredients) {
    const existing = await db.query.pantryItems.findFirst({
      where: eq(pantryItems.genericName, ing.genericName),
    });
    if (!existing) continue;

    const remaining = Math.max(0, Number(existing.gramsRemaining) - 300); // ~one portion's worth, best-effort
    await db
      .update(pantryItems)
      .set({ gramsRemaining: String(remaining), updatedAt: new Date() })
      .where(eq(pantryItems.id, existing.id));
  }
}

export interface PantrySummaryItem {
  genericName: string;
  gramsRemaining: number;
  /** Rough "how many more portions" estimate, assuming ~150g protein/portion. */
  estimatedPortionsRemaining: number;
}

export async function getPantrySummary(): Promise<PantrySummaryItem[]> {
  const rows = await db.select().from(pantryItems).where(gt(pantryItems.gramsRemaining, "0"));
  return rows.map((r) => ({
    genericName: r.genericName,
    gramsRemaining: Number(r.gramsRemaining),
    estimatedPortionsRemaining: Math.floor(Number(r.gramsRemaining) / 150),
  }));
}

/**
 * How many grams of pantry stock a candidate meal would use up, matched by
 * generic ingredient name. Used to bias meal selection toward using up what
 * was already bought instead of buying something new.
 */
export async function pantryOverlapGrams(mealId: number): Promise<number> {
  const ingredients = await db.query.mealIngredients.findMany({
    where: eq(mealIngredients.mealId, mealId),
  });
  if (ingredients.length === 0) return 0;

  const names = ingredients.map((i) => i.genericName);
  const rows = await db
    .select()
    .from(pantryItems)
    .where(and(inArray(pantryItems.genericName, names), gt(pantryItems.gramsRemaining, "0")));

  return rows.reduce((sum, r) => sum + Number(r.gramsRemaining), 0);
}
