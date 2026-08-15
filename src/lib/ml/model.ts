import { desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { dailyFeedback, meals, mlModel, mealHistory } from "../db/schema";
import { buildFeatureVector, FEATURE_NAMES, type FeatureContext } from "./features";
import { train, predict, type TrainedModel } from "./logisticRegression";
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
    const overlap = await pantryOverlapGrams(row.meal.id);
    const daysSince = await daysSinceLastServed(row.meal.id, row.feedback.date);

    const ctx: FeatureContext = {
      dayOfWeek: row.feedback.dayOfWeek,
      isWeekend: row.feedback.isWeekend,
      temperatureC: row.feedback.temperatureC !== null ? Number(row.feedback.temperatureC) : null,
    };
    X.push(buildFeatureVector(ctx, row.meal, { pantryOverlapGrams: overlap, daysSinceLastServed: daysSince }));
    y.push(row.feedback.accepted ? 1 : 0);
  }

  const model = train(X, y);

  await db.delete(mlModel);
  await db.insert(mlModel).values({
    featureNames: FEATURE_NAMES,
    weights: model.weights,
    bias: String(model.bias),
    sampleCount: rows.length,
  });

  return { trained: true, sampleCount: rows.length };
}

async function daysSinceLastServed(mealId: number, asOfDate: string): Promise<number | null> {
  const prior = await db.query.mealHistory.findMany({ where: eq(mealHistory.mealId, mealId) });
  const before = prior.filter((h) => h.servedDate < asOfDate);
  if (before.length === 0) return null;
  const mostRecent = before.reduce((a, b) => (a.servedDate > b.servedDate ? a : b));
  const days = (Date.parse(asOfDate) - Date.parse(mostRecent.servedDate)) / (1000 * 60 * 60 * 24);
  return Math.round(days);
}

export async function getLatestModel(): Promise<TrainedModel | null> {
  const row = await db.query.mlModel.findFirst({ orderBy: desc(mlModel.trainedAt) });
  if (!row) return null;
  return { weights: row.weights, bias: Number(row.bias) };
}

/**
 * Scores how likely tonight's context suggests accepting `meal`, using the
 * latest trained model. Returns null if no model has been trained yet —
 * callers should fall back to their existing (e.g. random) selection.
 */
export async function scoreMealForTonight(
  meal: MealRecord,
  ctx: FeatureContext
): Promise<number | null> {
  const model = await getLatestModel();
  if (!model) return null;

  const overlap = await pantryOverlapGrams(meal.id);
  const daysSince = await daysSinceLastServed(meal.id, londonDateString());
  const x = buildFeatureVector(ctx, meal, { pantryOverlapGrams: overlap, daysSinceLastServed: daysSince });
  return predict(model, x);
}
