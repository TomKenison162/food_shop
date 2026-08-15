import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { dailyFeedback, meals, mealIngredients, mlModel, mealHistory } from "../db/schema";
import { buildFeatureVector, FEATURE_NAMES, type FeatureContext, type MealFeatureExtras } from "./features";
import { trainXGBoost, scoreWithXGBoost } from "./xgboostModel";
import { pantryOverlapGrams } from "../pantry/pantry";
import type { MealRecord } from "../rotation";
import { londonDateString } from "../date";

const MIN_SAMPLES_PER_CLASS = 3;

export interface TrainResult {
  trained: boolean;
  reason?: string;
  sampleCount?: number;
}

/**
 * Retrains the ranking model from every daily_feedback row so far. Requires
 * a minimum number of both accepted and rejected examples — with too little
 * data, an overfit model would be worse than the existing random fallback,
 * so we skip training and say why rather than silently produce garbage.
 */
export async function trainModel(): Promise<TrainResult> {
  const rows = await db
    .select({ feedback: dailyFeedback, meal: meals })
    .from(dailyFeedback)
    .innerJoin(meals, eq(dailyFeedback.mealId, meals.id));

  const positives = rows.filter((r) => r.feedback.accepted).length;
  const negatives = rows.length - positives;

  if (positives < MIN_SAMPLES_PER_CLASS || negatives < MIN_SAMPLES_PER_CLASS) {
    return {
      trained: false,
      reason: `Need at least ${MIN_SAMPLES_PER_CLASS} accepted and ${MIN_SAMPLES_PER_CLASS} declined examples (have ${positives} accepted, ${negatives} declined).`,
      sampleCount: rows.length,
    };
  }

  const X: number[][] = [];
  const y: number[] = [];

  for (const row of rows) {
    // Approximation: pantry/recency features use *current* state rather than
    // a historical snapshot at feedback time — acceptable for a small,
    // personal, frequently-retrained model, but noted as a simplification.
    const extras = await buildExtras(row.meal, row.feedback.date);
    const ctx: FeatureContext = {
      dayOfWeek: row.feedback.dayOfWeek,
      isWeekend: row.feedback.isWeekend,
      temperatureC: row.feedback.temperatureC !== null ? Number(row.feedback.temperatureC) : null,
    };
    X.push(buildFeatureVector(ctx, row.meal, extras));
    y.push(row.feedback.accepted ? 1 : 0);
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

async function buildExtras(meal: MealRecord, asOfDate: string): Promise<MealFeatureExtras> {
  const [overlap, daysSince, proteinDaysSince, ingredients] = await Promise.all([
    pantryOverlapGrams(meal.id),
    daysSinceLastServed(meal.id, asOfDate),
    proteinDaysSinceLastServed(meal.primaryProtein, asOfDate),
    db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, meal.id) }),
  ]);
  return {
    pantryOverlapGrams: overlap,
    daysSinceLastServed: daysSince,
    proteinDaysSinceLastServed: proteinDaysSince,
    ingredientsCount: ingredients.length,
  };
}

async function daysSinceLastServed(mealId: number, asOfDate: string): Promise<number | null> {
  const prior = await db.query.mealHistory.findMany({ where: eq(mealHistory.mealId, mealId) });
  const before = prior.filter((h) => h.servedDate < asOfDate);
  if (before.length === 0) return null;
  const mostRecent = before.reduce((a, b) => (a.servedDate > b.servedDate ? a : b));
  return daysBetween(mostRecent.servedDate, asOfDate);
}

async function proteinDaysSinceLastServed(protein: string, asOfDate: string): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(eq(mealHistory.primaryProtein, protein));
  const before = rows.filter((h) => h.servedDate < asOfDate);
  if (before.length === 0) return null;
  const mostRecent = before.reduce((a, b) => (a.servedDate > b.servedDate ? a : b));
  return daysBetween(mostRecent.servedDate, asOfDate);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / (1000 * 60 * 60 * 24));
}

async function getLatestModelBuffer(): Promise<Uint8Array | null> {
  const row = await db.query.mlModel.findFirst({ orderBy: desc(mlModel.trainedAt) });
  if (!row) return null;
  return new Uint8Array(Buffer.from(row.modelDataBase64, "base64"));
}

/**
 * Scores a batch of candidate meals for tonight's context in one model
 * load (avoids reloading the WASM model per candidate). Returns null if no
 * model has been trained yet — callers should fall back to e.g. random pick.
 */
export async function scoreMealsForTonight(
  candidates: MealRecord[],
  ctx: FeatureContext
): Promise<number[] | null> {
  const modelBuffer = await getLatestModelBuffer();
  if (!modelBuffer) return null;

  const today = londonDateString();
  const X = await Promise.all(
    candidates.map(async (meal) => buildFeatureVector(ctx, meal, await buildExtras(meal, today)))
  );
  return scoreWithXGBoost(modelBuffer, X);
}
