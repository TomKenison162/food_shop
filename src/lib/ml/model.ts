import { and, desc, eq, gt, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { db } from "../db/client";
import { meals, mealIngredients, mlModel, mealHistory, mealOffers, pantryItems } from "../db/schema";
import { isDeclineReason, isPreferenceSignal } from "../declineReasons";
import { dishFeatures } from "./dishFeatures";
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

export interface TrainingSet {
  X: number[][];
  y: number[];
  fromOffers: number;
  fromReplies: number;
  excludedNotHome: number;
  /** Ratings of exactly 3, dropped as genuine ambivalence. */
  excludedAmbivalent: number;
}

/**
 * Assembles training examples from the two signals the email produces.
 *
 * 1. Offer groups (meal_offers). The email shows a primary plus alternatives;
 *    clicking one labels every meal in that group at once — one positive and
 *    the rest negatives, all sharing a context exactly. This is the dense,
 *    comparative signal: it isolates what distinguishes *meals* rather than
 *    what distinguishes Tuesdays, and one reply yields several examples.
 *    Unresolved groups are skipped, because nobody replying is not a dislike.
 *
 * 2. Accept/decline replies (meal_history), minus "not home" — that says
 *    nothing about food, and training on it is how a week away used to teach
 *    the model to hate whatever it happened to suggest.
 *
 * Both sources use feature values snapshotted when the suggestion was made,
 * never recomputed: pantry state, recency and weather all drift, and weather
 * can't be re-fetched for a past date.
 */
export async function buildTrainingSet(): Promise<TrainingSet> {
  const X: number[][] = [];
  const y: number[] = [];

  // Recipe character (effort, richness, carb base) is derived rather than
  // stored: unlike weather or pantry state it doesn't drift, so there's
  // nothing to snapshot. Fetched once for every meal here instead of per
  // training row.
  const allIngredients = await db
    .select({ mealId: mealIngredients.mealId, genericName: mealIngredients.genericName })
    .from(mealIngredients);
  const ingredientsByMeal = new Map<number, string[]>();
  for (const row of allIngredients) {
    const list = ingredientsByMeal.get(row.mealId) ?? [];
    list.push(row.genericName);
    ingredientsByMeal.set(row.mealId, list);
  }

  const toVector = (
    snap: {
      dayOfWeek: number | null;
      isWeekend: boolean | null;
      temperatureC: string | null;
      apparentTemperatureC: string | null;
      precipitationMm: string | null;
      pantryOverlapGrams: string | null;
      daysSinceLastServed: number | null;
      proteinDaysSinceLastServed: number | null;
      ingredientsCount: number | null;
    },
    meal: MealRecord
  ): number[] => {
    const ctx: FeatureContext = {
      dayOfWeek: snap.dayOfWeek ?? 0,
      isWeekend: snap.isWeekend ?? false,
      temperatureC: snap.temperatureC !== null ? Number(snap.temperatureC) : null,
      apparentTemperatureC: snap.apparentTemperatureC !== null ? Number(snap.apparentTemperatureC) : null,
      precipitationMm: snap.precipitationMm !== null ? Number(snap.precipitationMm) : null,
    };
    const extras: MealFeatureExtras = {
      pantryOverlapGrams: snap.pantryOverlapGrams !== null ? Number(snap.pantryOverlapGrams) : 0,
      daysSinceLastServed: snap.daysSinceLastServed,
      proteinDaysSinceLastServed: snap.proteinDaysSinceLastServed,
      ingredientsCount: snap.ingredientsCount ?? 0,
      dish: dishFeatures(meal.instructions, ingredientsByMeal.get(meal.id) ?? []),
    };
    return buildFeatureVector(ctx, meal, extras);
  };

  const offerRows = await db
    .select({ offer: mealOffers, meal: meals })
    .from(mealOffers)
    .innerJoin(meals, eq(mealOffers.mealId, meals.id))
    .where(isNotNull(mealOffers.resolvedAt));

  for (const { offer, meal } of offerRows) {
    X.push(toVector(offer, meal));
    y.push(offer.wasChosen ? 1 : 0);
  }

  const replyRows = await db
    .select({ history: mealHistory, meal: meals })
    .from(mealHistory)
    .innerJoin(meals, eq(mealHistory.mealId, meals.id))
    .where(isNotNull(mealHistory.accepted));

  let excludedNotHome = 0;
  let excludedAmbivalent = 0;
  let fromReplies = 0;
  for (const { history, meal } of replyRows) {
    const reason = history.declineReason;
    if (reason !== null && isDeclineReason(reason) && !isPreferenceSignal(reason)) {
      // "Not home" and "got leftovers" settle the evening without judging
      // the food. Training on them teaches the model to dislike whatever it
      // happened to suggest while you were busy.
      excludedNotHome++;
      continue;
    }

    // A rating turns "I cooked it" into how much it was actually wanted.
    // 3 out of 5 is genuine ambivalence and is dropped rather than being
    // rounded into a weak yes, which would just add noise. A low rating on
    // a meal you did cook is one of the most informative labels available:
    // it separates "wrong dish" from "wrong evening" in a way accept/decline
    // never could.
    if (history.accepted && history.rating !== null) {
      if (history.rating === 3) {
        excludedAmbivalent++;
        continue;
      }
      X.push(toVector(history, meal));
      y.push(history.rating >= 4 ? 1 : 0);
      fromReplies++;
      continue;
    }

    X.push(toVector(history, meal));
    y.push(history.accepted ? 1 : 0);
    fromReplies++;
  }

  return { X, y, fromOffers: offerRows.length, fromReplies, excludedNotHome, excludedAmbivalent };
}

/**
 * Retrains the ranking model from every resolved offer and answered reply.
 *
 * Requires a minimum of both classes: with less, an overfit model would be
 * worse than the random fallback, so we skip and say why rather than produce
 * something confidently wrong. The offer signal fills this far faster than
 * the old one — a single evening's reply now labels three meals instead of
 * one, so the gate clears in days rather than weeks.
 */
export async function trainModel(): Promise<TrainResult> {
  const { X, y, fromOffers, fromReplies, excludedNotHome, excludedAmbivalent } = await buildTrainingSet();

  const positives = y.filter((v) => v === 1).length;
  const negatives = y.length - positives;

  if (positives < MIN_SAMPLES_PER_CLASS || negatives < MIN_SAMPLES_PER_CLASS) {
    return {
      trained: false,
      reason:
        `Need at least ${MIN_SAMPLES_PER_CLASS} of each class (have ${positives} positive, ${negatives} negative` +
        ` from ${fromOffers} offer rows and ${fromReplies} replies` +
        `${excludedNotHome > 0 ? `; ${excludedNotHome} non-food declines excluded` : ""}` +
        `${excludedAmbivalent > 0 ? `; ${excludedAmbivalent} rated 3/5 and dropped` : ""}).`,
      sampleCount: y.length,
    };
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
      sampleCount: y.length,
      accuracy: evaluation.accuracy,
      baselineAccuracy: evaluation.baselineAccuracy,
    };
  }

  const modelBuffer = await trainXGBoost(X, y);

  await db.delete(mlModel);
  await db.insert(mlModel).values({
    featureNames: FEATURE_NAMES,
    modelDataBase64: Buffer.from(modelBuffer).toString("base64"),
    sampleCount: y.length,
    accuracy: String(evaluation.accuracy),
    baselineAccuracy: String(evaluation.baselineAccuracy),
  });

  return {
    trained: true,
    sampleCount: y.length,
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
      dish: dishFeatures(meal.instructions, names),
    });
  });

  return scoreWithXGBoost(modelBuffer, X);
}
