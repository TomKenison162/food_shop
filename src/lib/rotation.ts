import { eq, gte, sql } from "drizzle-orm";
import { db } from "./db/client";
import { approvedQueue, meals, mealHistory } from "./db/schema";
import { addDaysToDateString, isLondonWeekend, londonDateString, londonDayOfWeek } from "./date";
import { getCurrentTemperatureC } from "./weather/weather";
import { scoreMealForTonight } from "./ml/model";
import { consumePantryForMeal } from "./pantry/pantry";

const REPEAT_WINDOW_DAYS = 60;
const MAX_SERVES_IN_WINDOW = 2;

export type MealRecord = typeof meals.$inferSelect;

export interface RotationResult {
  meal: MealRecord;
  alreadySelectedToday: boolean;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  /** true if a trained ML model ranked the pool; false if it fell back to random (not enough feedback yet). */
  usedModel: boolean;
}

/**
 * Picks (and persists) tonight's dinner from the approved queue, applying:
 *  - anti-repetition: a meal can't be served a 3rd time within 60 days
 *  - protein rotation: excludes yesterday's primary protein entirely
 * Idempotent per calendar day (Europe/London) — calling this twice on the
 * same day returns the same meal instead of re-rolling.
 */
export async function selectTonightsDinner(now: Date = new Date()): Promise<RotationResult | null> {
  const today = londonDateString(now);

  const existing = await db.query.mealHistory.findFirst({
    where: eq(mealHistory.servedDate, today),
  });
  if (existing) {
    const meal = await db.query.meals.findFirst({ where: eq(meals.id, existing.mealId) });
    if (meal) {
      return {
        meal,
        alreadySelectedToday: true,
        relaxedProteinRule: false,
        relaxedRepeatRule: false,
        usedModel: false,
      };
    }
  }

  const approved = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .groupBy(meals.id, approvedQueue.mealId);
  const approvedMeals = dedupeById(approved.map((r) => r.meal));
  if (approvedMeals.length === 0) return null;

  const windowStart = addDaysToDateString(today, -REPEAT_WINDOW_DAYS);
  const recentServes = await db
    .select({ mealId: mealHistory.mealId, count: sql<number>`count(*)`.as("count") })
    .from(mealHistory)
    .where(gte(mealHistory.servedDate, windowStart))
    .groupBy(mealHistory.mealId);
  const overExposedIds = new Set(
    recentServes.filter((r) => r.count >= MAX_SERVES_IN_WINDOW).map((r) => r.mealId)
  );

  const yesterday = addDaysToDateString(today, -1);
  const yesterdaysMeal = await db.query.mealHistory.findFirst({
    where: eq(mealHistory.servedDate, yesterday),
  });
  const bannedProtein = yesterdaysMeal?.primaryProtein ?? null;

  const notOverExposed = approvedMeals.filter((m) => !overExposedIds.has(m.id));

  let pool = bannedProtein
    ? notOverExposed.filter((m) => m.primaryProtein !== bannedProtein)
    : notOverExposed;
  let relaxedProteinRule = false;
  let relaxedRepeatRule = false;

  if (pool.length === 0) {
    // Fallback 1: drop the protein-rotation rule, keep anti-repetition.
    pool = notOverExposed;
    relaxedProteinRule = true;
  }
  if (pool.length === 0) {
    // Fallback 2: the whole approved queue is over-exposed; drop that rule too.
    pool = approvedMeals;
    relaxedRepeatRule = true;
  }

  const { chosen, usedModel } = await pickFromPool(pool, now);

  await db.insert(mealHistory).values({
    mealId: chosen.id,
    primaryProtein: chosen.primaryProtein,
    servedDate: today,
  });
  await consumePantryForMeal(chosen.id);

  return { meal: chosen, alreadySelectedToday: false, relaxedProteinRule, relaxedRepeatRule, usedModel };
}

/**
 * Ranks the surviving candidate pool with the trained ML model (contextual
 * yes/no feedback — day of week, weekend, temperature, pantry overlap,
 * recency) and picks the top-scoring meal. Falls back to a uniform random
 * pick when no model has been trained yet (too little feedback so far).
 */
async function pickFromPool(
  pool: MealRecord[],
  now: Date
): Promise<{ chosen: MealRecord; usedModel: boolean }> {
  const ctx = {
    dayOfWeek: londonDayOfWeek(now),
    isWeekend: isLondonWeekend(now),
    temperatureC: await getCurrentTemperatureC(),
  };

  const scored = await Promise.all(
    pool.map(async (meal) => ({ meal, score: await scoreMealForTonight(meal, ctx) }))
  );

  if (scored.some((s) => s.score === null)) {
    // No trained model yet.
    return { chosen: pool[Math.floor(Math.random() * pool.length)], usedModel: false };
  }

  const best = scored.reduce((a, b) => ((b.score as number) > (a.score as number) ? b : a));
  return { chosen: best.meal, usedModel: true };
}

function dedupeById(list: MealRecord[]): MealRecord[] {
  const seen = new Map<number, MealRecord>();
  for (const m of list) seen.set(m.id, m);
  return [...seen.values()];
}

export async function isMealApproved(mealId: number): Promise<boolean> {
  const row = await db.query.approvedQueue.findFirst({ where: eq(approvedQueue.mealId, mealId) });
  return !!row;
}
