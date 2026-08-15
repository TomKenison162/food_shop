import { and, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../db/client";
import { meals, mealIngredients, mlModel, mealHistory, pantryItems } from "../db/schema";
import { buildFeatureVector, FEATURE_NAMES, type FeatureContext, type MealFeatureExtras } from "./features";
import { trainXGBoost, scoreWithXGBoost } from "./xgboostModel";
import { leaveOneOutEvaluate } from "./evaluate";
import type { MealRecord } from "../rotationDecision";
import { londonDateString } from "../date";

/**
 * Below this the model can't discriminate: measured on this feature set,
 * ~10 labelled days produced only 7 distinct scores across 51 candidate
 * meals, five of them tied. Waiting for more data costs nothing — the rules
 * (protein rotation, anti-repetition, budget) still choose sensibly on
 * their own, with a random pick among the survivors.
 */
const MIN_SAMPLES_PER_CLASS = 5;

export interface TrainResult {
  trained: boolean;
  reason?: string;
  sampleCount?: number;
  accuracy?: number;
  baselineAccuracy?: number;
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

  // Only ship a model that demonstrably beats guessing the majority class.
  // Storing one that doesn't would make selection *worse* than the random
  // fallback: it adds confident noise on top of rules that already work.
  const evaluation = await leaveOneOutEvaluate(X, y);
  if (!evaluation.beatsBaseline) {
    await db.delete(mlModel);
    return {
      trained: false,
      reason:
        `Model scored ${(evaluation.accuracy * 100).toFixed(0)}% vs a ` +
        `${(evaluation.baselineAccuracy * 100).toFixed(0)}% majority-class baseline — ` +
        `not better than guessing, so it's not being used yet.`,
      sampleCount: rows.length,
      accuracy: evaluation.accuracy,
      baselineAccuracy: evaluation.baselineAccuracy,
    };
  }

  const modelBuffer = await trainXGBoost(X, y);

  await db.delete(mlModel);
  await db.insert(mlModel).values({
    featureNames: FEATURE_NAMES,
    modelDataBase64: Buffer.from(modelBuffer).toString("base64"),
    sampleCount: rows.length,
    accuracy: String(evaluation.accuracy),
    baselineAccuracy: String(evaluation.baselineAccuracy),
  });

  return {
    trained: true,
    sampleCount: rows.length,
    accuracy: evaluation.accuracy,
    baselineAccuracy: evaluation.baselineAccuracy,
  };
}

async function getLatestModelBuffer(): Promise<Uint8Array | null> {
  const row = await db.query.mlModel.findFirst({ orderBy: desc(mlModel.trainedAt) });
  if (!row) return null;
  return new Uint8Array(Buffer.from(row.modelDataBase64, "base64"));
}

/**
 * Scores candidate meals for tonight's context.
 *
 * All the per-meal feature inputs are fetched in a handful of grouped
 * queries rather than per candidate: the previous shape ran four queries
 * for each of ~50 approved meals, so every single dinner selection cost
 * roughly 200 round trips.
 *
 * Returns null when no model is stored — either never trained, or trained
 * and rejected for not beating the baseline — and callers fall back to a
 * random pick among the rule-filtered survivors.
 */
export async function scoreMealsForTonight(
  candidates: MealRecord[],
  ctx: FeatureContext
): Promise<number[] | null> {
  const modelBuffer = await getLatestModelBuffer();
  if (!modelBuffer || candidates.length === 0) return null;

  const today = londonDateString();
  const mealIds = candidates.map((m) => m.id);

  const [pantry, ingredientRows, historyRows] = await Promise.all([
    db.select().from(pantryItems).where(gt(pantryItems.gramsRemaining, "0")),
    db.select().from(mealIngredients).where(inArray(mealIngredients.mealId, mealIds)),
    db
      .select({
        mealId: mealHistory.mealId,
        primaryProtein: mealHistory.primaryProtein,
        servedDate: mealHistory.servedDate,
      })
      .from(mealHistory)
      .where(and(lt(mealHistory.servedDate, today), isNull(mealHistory.supersededAt))),
  ]);

  const pantryByName = new Map(pantry.map((p) => [p.genericName, Number(p.gramsRemaining)]));

  const ingredientsByMeal = new Map<number, string[]>();
  for (const row of ingredientRows) {
    const list = ingredientsByMeal.get(row.mealId) ?? [];
    list.push(row.genericName);
    ingredientsByMeal.set(row.mealId, list);
  }

  const lastServedByMeal = new Map<number, string>();
  const lastServedByProtein = new Map<string, string>();
  for (const h of historyRows) {
    const m = lastServedByMeal.get(h.mealId);
    if (!m || h.servedDate > m) lastServedByMeal.set(h.mealId, h.servedDate);
    const p = lastServedByProtein.get(h.primaryProtein);
    if (!p || h.servedDate > p) lastServedByProtein.set(h.primaryProtein, h.servedDate);
  }

  const gapDays = (from: string | undefined): number | null =>
    from === undefined
      ? null
      : Math.round((Date.parse(today) - Date.parse(from)) / (1000 * 60 * 60 * 24));

  const X = candidates.map((meal) => {
    const names = ingredientsByMeal.get(meal.id) ?? [];
    const overlap = names.reduce((sum, n) => sum + (pantryByName.get(n) ?? 0), 0);
    return buildFeatureVector(ctx, meal, {
      pantryOverlapGrams: overlap,
      daysSinceLastServed: gapDays(lastServedByMeal.get(meal.id)),
      proteinDaysSinceLastServed: gapDays(lastServedByProtein.get(meal.primaryProtein)),
      ingredientsCount: names.length,
    });
  });

  return scoreWithXGBoost(modelBuffer, X);
}
