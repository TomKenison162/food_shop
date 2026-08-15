import { desc, eq, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { meals, mealIngredients, mlModel, mealHistory } from "../db/schema";
import { buildFeatureVector, FEATURE_NAMES, type FeatureContext, type MealFeatureExtras } from "./features";
import { trainXGBoost, scoreWithXGBoost } from "./xgboostModel";
import { pantryOverlapGrams } from "../pantry/pantry";
import type { MealRecord } from "../rotationDecision";
import { londonDateString } from "../date";

const MIN_SAMPLES_PER_CLASS = 3;

export interface TrainResult {
  trained: boolean;
  reason?: string;
  sampleCount?: number;
}

/**
 * Retrains the ranking model from every answered daily reminder so far.
 *
 * Training examples come straight from meal_history, where every feature
 * was snapshotted at serve time — so the model learns from the world as it
 * was when each suggestion was made, not as it looks at retrain time. (An
 * earlier version recomputed pantry/recency features from *current* state,
 * which silently mislabelled every historical example.)
 *
 * Requires a minimum of both accepted and declined examples: with less, an
 * overfit model would be worse than the random fallback, so we skip and say
 * why rather than produce something confidently wrong.
 */
export async function trainModel(): Promise<TrainResult> {
  const rows = await db
    .select({ history: mealHistory, meal: meals })
    .from(mealHistory)
    .innerJoin(meals, eq(mealHistory.mealId, meals.id))
    .where(isNotNull(mealHistory.accepted));

  const positives = rows.filter((r) => r.history.accepted === true).length;
  const negatives = rows.length - positives;

  if (positives < MIN_SAMPLES_PER_CLASS || negatives < MIN_SAMPLES_PER_CLASS) {
    return {
      trained: false,
      reason: `Need at least ${MIN_SAMPLES_PER_CLASS} accepted and ${MIN_SAMPLES_PER_CLASS} declined replies (have ${positives} accepted, ${negatives} declined).`,
      sampleCount: rows.length,
    };
  }

  const X: number[][] = [];
  const y: number[] = [];

  for (const { history, meal } of rows) {
    const ctx: FeatureContext = {
      dayOfWeek: history.dayOfWeek ?? 0,
      isWeekend: history.isWeekend ?? false,
      temperatureC: history.temperatureC !== null ? Number(history.temperatureC) : null,
    };
    const extras: MealFeatureExtras = {
      pantryOverlapGrams: history.pantryOverlapGrams !== null ? Number(history.pantryOverlapGrams) : 0,
      daysSinceLastServed: history.daysSinceLastServed,
      proteinDaysSinceLastServed: history.proteinDaysSinceLastServed,
      ingredientsCount: history.ingredientsCount ?? 0,
    };
    X.push(buildFeatureVector(ctx, meal, extras));
    y.push(history.accepted ? 1 : 0);
  }

  const modelBuffer = await trainXGBoost(X, y);

  await db.delete(mlModel);
  await db.insert(mlModel).values({
    featureNames: FEATURE_NAMES,
    modelDataBase64: Buffer.from(modelBuffer).toString("base64"),
    sampleCount: rows.length,
  });

  return { trained: true, sampleCount: rows.length };
}

async function getLatestModelBuffer(): Promise<Uint8Array | null> {
  const row = await db.query.mlModel.findFirst({ orderBy: desc(mlModel.trainedAt) });
  if (!row) return null;
  return new Uint8Array(Buffer.from(row.modelDataBase64, "base64"));
}

/**
 * Scores candidate meals for tonight's context in one model load (avoids
 * reloading the WASM model per candidate). Returns null if no model has
 * been trained yet — callers fall back to a random pick.
 */
export async function scoreMealsForTonight(
  candidates: MealRecord[],
  ctx: FeatureContext
): Promise<number[] | null> {
  const modelBuffer = await getLatestModelBuffer();
  if (!modelBuffer) return null;

  const today = londonDateString();
  // Imported lazily to avoid a circular import: rotation.ts imports this
  // module for scoring, and these helpers live alongside the persistence
  // logic there.
  const { daysSinceLastServed, proteinDaysSinceLastServed } = await import("../rotation");

  const X: number[][] = [];
  for (const meal of candidates) {
    const [overlap, ingredients, lastServed, proteinLastServed] = await Promise.all([
      pantryOverlapGrams(meal.id),
      db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, meal.id) }),
      daysSinceLastServed(meal.id, today),
      proteinDaysSinceLastServed(meal.primaryProtein, today),
    ]);
    X.push(
      buildFeatureVector(ctx, meal, {
        pantryOverlapGrams: overlap,
        daysSinceLastServed: lastServed,
        proteinDaysSinceLastServed: proteinLastServed,
        ingredientsCount: ingredients.length,
      })
    );
  }

  return scoreWithXGBoost(modelBuffer, X);
}
