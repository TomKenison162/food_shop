import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { mealIngredients } from "./db/schema";

/** Ingredient lines for a single meal, for the daily "cook this tonight" email. */
export function ingredientsForMeal(mealId: number) {
  return db.select().from(mealIngredients).where(eq(mealIngredients.mealId, mealId));
}
