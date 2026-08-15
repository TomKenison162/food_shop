import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "./db/client";
import { approvedQueue, meals, mealHistory, mealIngredients } from "./db/schema";
import { addDaysToDateString, isLondonWeekend, londonDateString, londonDayOfWeek } from "./date";
import {
  consumePantryForMeal,
  pantryOverlapGrams,
  recordPurchaseLeftoversForMeal,
} from "./pantry/pantry";
import { getCurrentTemperatureC } from "./weather/weather";
import { scoreMealsForTonight } from "./ml/model";
import { getPortionsSetting } from "./settings";
import { costForPortions, WEEKLY_BUDGET_GBP } from "./budget";
import { spentInWeek } from "./budgetSpend";
import { decideTonightsDinner, REPEAT_WINDOW_DAYS, type MealRecord } from "./rotationDecision";
import type { FeatureContext } from "./ml/features";

export type { MealRecord };

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
 * Gathers today's state, delegates the actual choice to the pure
 * decideTonightsDinner (see rotationDecision.ts, where the rules live and
 * are tested), then persists the result along with a full context snapshot
 * for the ML model to train on later.
 *
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
        spentThisWeekGBP: await spentInWeek(today),
      };
    }
  }

  const approved = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .groupBy(meals.id, approvedQueue.mealId);
  const approvedMeals = dedupeById(approved.map((r) => r.meal)).filter((m) => m.deletedAt === null);
  if (approvedMeals.length === 0) return null;

  const windowStart = addDaysToDateString(today, -REPEAT_WINDOW_DAYS);
  const recentServes = await db
    .select({ mealId: mealHistory.mealId, count: sql<number>`count(*)`.as("count") })
    .from(mealHistory)
    .where(gte(mealHistory.servedDate, windowStart))
    .groupBy(mealHistory.mealId);
  const servesInWindow = new Map(recentServes.map((r) => [r.mealId, Number(r.count)]));

  const yesterdaysMeal = await db.query.mealHistory.findFirst({
    where: eq(mealHistory.servedDate, addDaysToDateString(today, -1)),
  });

  const spentThisWeek = await spentInWeek(today);
  const scoreList = await scoreMealsForTonight(approvedMeals, context);
  const scores = scoreList ? new Map(approvedMeals.map((m, i) => [m.id, scoreList[i]])) : null;

  const decision = decideTonightsDinner({
    portions,
    approvedMeals,
    servesInWindow,
    yesterdaysProtein: yesterdaysMeal?.primaryProtein ?? null,
    spentThisWeek,
    weeklyBudget: WEEKLY_BUDGET_GBP,
    scores,
  });
  if (!decision) return null;

  const chosen = decision.meal;
  const cost = costForPortions(chosen, portions);

  // Snapshot the feature values as they are right now — weather can't be
  // re-fetched for a past date, and pantry/recency drift, so a training
  // example has to record the world as it was when the call was made.
  const [overlap, ingredientCount, lastServed, proteinLastServed] = await Promise.all([
    pantryOverlapGrams(chosen.id),
    countIngredients(chosen.id),
    daysSinceLastServed(chosen.id, today),
    proteinDaysSinceLastServed(chosen.primaryProtein, today),
  ]);

  await db.insert(mealHistory).values({
    mealId: chosen.id,
    primaryProtein: chosen.primaryProtein,
    servedDate: today,
    portions,
    costIncurred: cost !== null ? String(cost) : null,
    dayOfWeek: context.dayOfWeek,
    isWeekend: context.isWeekend,
    temperatureC: context.temperatureC !== null ? String(context.temperatureC) : null,
    pantryOverlapGrams: String(overlap),
    daysSinceLastServed: lastServed,
    proteinDaysSinceLastServed: proteinLastServed,
    ingredientsCount: ingredientCount,
  });

  await recordPurchaseLeftoversForMeal(chosen.id);
  await consumePantryForMeal(chosen.id);

  return {
    meal: chosen,
    portions,
    cost,
    context,
    alreadySelectedToday: false,
    relaxedProteinRule: decision.relaxedProteinRule,
    relaxedRepeatRule: decision.relaxedRepeatRule,
    relaxedBudgetRule: decision.relaxedBudgetRule,
    usedModel: decision.usedModel,
    spentThisWeekGBP: spentThisWeek + (cost ?? 0),
  };
}

async function countIngredients(mealId: number): Promise<number> {
  const rows = await db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, mealId) });
  return rows.length;
}

export async function daysSinceLastServed(mealId: number, asOfDate: string): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(and(eq(mealHistory.mealId, mealId), sql`${mealHistory.servedDate} < ${asOfDate}`));
  return mostRecentGap(rows.map((r) => r.servedDate), asOfDate);
}

export async function proteinDaysSinceLastServed(
  protein: string,
  asOfDate: string
): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(and(eq(mealHistory.primaryProtein, protein), sql`${mealHistory.servedDate} < ${asOfDate}`));
  return mostRecentGap(rows.map((r) => r.servedDate), asOfDate);
}

function mostRecentGap(dates: string[], asOfDate: string): number | null {
  if (dates.length === 0) return null;
  const mostRecent = dates.reduce((a, b) => (a > b ? a : b));
  return Math.round((Date.parse(asOfDate) - Date.parse(mostRecent)) / (1000 * 60 * 60 * 24));
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
