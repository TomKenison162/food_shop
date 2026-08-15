import { eq, gte, sql } from "drizzle-orm";
import { db } from "./db/client";
import { approvedQueue, meals, mealHistory } from "./db/schema";
import { addDaysToDateString, isLondonWeekend, londonDateString, londonDayOfWeek } from "./date";
import { consumePantryForMeal } from "./pantry/pantry";
import { getCurrentTemperatureC } from "./weather/weather";
import { scoreMealsForTonight } from "./ml/model";
import { getPortionsSetting } from "./settings";
import { spentInRollingWeek, costForPortions, WEEKLY_BUDGET_GBP } from "./budget";
import type { FeatureContext } from "./ml/features";

const REPEAT_WINDOW_DAYS = 60;
const MAX_SERVES_IN_WINDOW = 2;

export type MealRecord = typeof meals.$inferSelect;

export interface RotationResult {
  meal: MealRecord;
  portions: 1 | 2;
  cost: number | null;
  context: FeatureContext;
  alreadySelectedToday: boolean;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  usedModel: boolean;
  spentThisWeekGBP: number;
}

/**
 * Picks (and persists) tonight's dinner from the approved queue, applying:
 *  - anti-repetition: a meal can't be served a 3rd time within 60 days
 *  - protein rotation: excludes yesterday's primary protein entirely
 *  - weekly budget: prefers candidates that keep the trailing 7-day spend
 *    (at the current portions setting) under WEEKLY_BUDGET_GBP
 *  - ML ranking: once a model has been trained on real daily accept/deny
 *    feedback (see src/lib/ml/model.ts), the survivors are ranked by it;
 *    otherwise picked uniformly at random
 * Idempotent per calendar day (Europe/London) — calling this twice on the
 * same day returns the same meal instead of re-rolling.
 */
export async function selectTonightsDinner(now: Date = new Date()): Promise<RotationResult | null> {
  const today = londonDateString(now);
  const portions = await getPortionsSetting();
  const context: FeatureContext = {
    dayOfWeek: londonDayOfWeek(now),
    isWeekend: isLondonWeekend(now),
    temperatureC: await getCurrentTemperatureC(),
  };

  const existing = await db.query.mealHistory.findFirst({
    where: eq(mealHistory.servedDate, today),
  });
  if (existing) {
    const meal = await db.query.meals.findFirst({ where: eq(meals.id, existing.mealId) });
    if (meal) {
      return {
        meal,
        portions: existing.portions === 1 ? 1 : 2,
        cost: existing.costIncurred !== null ? Number(existing.costIncurred) : null,
        context,
        alreadySelectedToday: true,
        relaxedProteinRule: false,
        relaxedRepeatRule: false,
        relaxedBudgetRule: false,
        usedModel: false,
        spentThisWeekGBP: await spentInRollingWeek(today),
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

  // Weekly budget: prefer candidates that don't push the trailing 7-day
  // spend over WEEKLY_BUDGET_GBP. A meal must always be served, so if every
  // survivor would bust the budget, fall back to the cheapest one instead
  // of dropping the constraint silently.
  const spentSoFar = await spentInRollingWeek(today);
  const remaining = WEEKLY_BUDGET_GBP - spentSoFar;
  const withinBudget = pool.filter((m) => {
    const cost = costForPortions(m, portions);
    return cost === null || cost <= remaining; // unpriced meals can't be budget-checked yet
  });
  let relaxedBudgetRule = false;
  if (withinBudget.length > 0) {
    pool = withinBudget;
  } else {
    relaxedBudgetRule = true;
    pool = [cheapestOf(pool, portions)];
  }

  const { chosen, usedModel } = await pickFromPool(pool, context);
  const cost = costForPortions(chosen, portions);

  await db.insert(mealHistory).values({
    mealId: chosen.id,
    primaryProtein: chosen.primaryProtein,
    servedDate: today,
    portions,
    costIncurred: cost !== null ? String(cost) : null,
  });
  await consumePantryForMeal(chosen.id);

  return {
    meal: chosen,
    portions,
    cost,
    context,
    alreadySelectedToday: false,
    relaxedProteinRule,
    relaxedRepeatRule,
    relaxedBudgetRule,
    usedModel,
    spentThisWeekGBP: spentSoFar + (cost ?? 0),
  };
}

function cheapestOf(pool: MealRecord[], portions: 1 | 2): MealRecord {
  return pool.reduce((cheapest, m) => {
    const a = costForPortions(m, portions);
    const b = costForPortions(cheapest, portions);
    if (a === null) return cheapest;
    if (b === null) return m;
    return a < b ? m : cheapest;
  }, pool[0]);
}

async function pickFromPool(
  pool: MealRecord[],
  ctx: FeatureContext
): Promise<{ chosen: MealRecord; usedModel: boolean }> {
  const scores = await scoreMealsForTonight(pool, ctx);
  if (scores === null) {
    // No trained model yet — needs real daily accept/deny history first.
    return { chosen: pool[Math.floor(Math.random() * pool.length)], usedModel: false };
  }

  let bestIndex = 0;
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > scores[bestIndex]) bestIndex = i;
  }
  return { chosen: pool[bestIndex], usedModel: true };
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
