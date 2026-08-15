import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "./db/client";
import { approvedQueue, meals, mealHistory, mealIngredients } from "./db/schema";
import { addDaysToDateString, dayOfWeekForDateString, londonDateString } from "./date";
import {
  consumePantryForMeal,
  pantryOverlapGrams,
  recordPurchaseLeftoversForMeal,
} from "./pantry/pantry";
import { getCurrentTemperatureC } from "./weather/weather";
import { scoreMealsForTonight } from "./ml/model";
import { getPortionsSetting } from "./settings";
import { spentInWeek } from "./budgetSpend";
import { costForPortions, firstShopCostForPortions, WEEKLY_BUDGET_GBP } from "./budget";
import { decideTonightsDinner, REPEAT_WINDOW_DAYS, type MealRecord } from "./rotationDecision";
import type { FeatureContext } from "./ml/features";

export type { MealRecord };

export type PlannedMeal = typeof mealHistory.$inferSelect;

export interface RotationResult {
  meal: MealRecord;
  /** The date this plan is for (YYYY-MM-DD, Europe/London). */
  planDate: string;
  portions: 1 | 2;
  cost: number | null;
  firstShopCost: number | null;
  context: FeatureContext;
  alreadySelectedToday: boolean;
  relaxedProteinRule: boolean;
  relaxedRepeatRule: boolean;
  relaxedBudgetRule: boolean;
  usedModel: boolean;
  spentThisWeekGBP: number;
  firstShopSpentThisWeekGBP: number;
}

/** The live (non-superseded) plan row for a date, if one exists. */
export async function getPlannedMeal(date: string): Promise<PlannedMeal | undefined> {
  return db.query.mealHistory.findFirst({
    where: and(eq(mealHistory.servedDate, date), isNull(mealHistory.supersededAt)),
  });
}

/**
 * Ensures a meal is chosen and persisted for `date`, returning it either
 * way. Idempotent: if a live plan row already exists it's returned
 * unchanged (`alreadySelectedToday: true`) rather than re-rolled.
 *
 * `excludeMealIds` lets a declined suggestion be replaced without the
 * engine handing back the same dish.
 */
export async function planMealForDate(
  date: string,
  opts: { excludeMealIds?: number[]; now?: Date } = {}
): Promise<RotationResult | null> {
  const { excludeMealIds = [], now = new Date() } = opts;
  const portions = await getPortionsSetting();

  const existing = await getPlannedMeal(date);
  if (existing) {
    const meal = await db.query.meals.findFirst({ where: eq(meals.id, existing.mealId) });
    if (meal) {
      const [spent, firstShopSpent] = await spendTotals(date);
      return {
        meal,
        planDate: date,
        portions: existing.portions === 1 ? 1 : 2,
        cost: existing.costIncurred !== null ? Number(existing.costIncurred) : null,
        firstShopCost: existing.firstShopCost !== null ? Number(existing.firstShopCost) : null,
        context: {
          dayOfWeek: existing.dayOfWeek ?? dayOfWeekForDateString(date),
          isWeekend: existing.isWeekend ?? false,
          temperatureC: existing.temperatureC !== null ? Number(existing.temperatureC) : null,
        },
        alreadySelectedToday: true,
        relaxedProteinRule: false,
        relaxedRepeatRule: false,
        relaxedBudgetRule: false,
        usedModel: false,
        spentThisWeekGBP: spent,
        firstShopSpentThisWeekGBP: firstShopSpent,
      };
    }
  }

  const dow = dayOfWeekForDateString(date);
  const context: FeatureContext = {
    dayOfWeek: dow,
    isWeekend: dow === 0 || dow === 6,
    // Weather is only meaningful for today; a plan built days ahead can't
    // know it, and guessing would poison the training snapshot.
    temperatureC: date === londonDateString(now) ? await getCurrentTemperatureC() : null,
  };

  const approvedMeals = (await approvedMealRecords()).filter((m) => !excludeMealIds.includes(m.id));
  if (approvedMeals.length === 0) return null;

  const windowStart = addDaysToDateString(date, -REPEAT_WINDOW_DAYS);
  const recentServes = await db
    .select({ mealId: mealHistory.mealId, count: sql<number>`count(*)`.as("count") })
    .from(mealHistory)
    .where(and(gte(mealHistory.servedDate, windowStart), isNull(mealHistory.supersededAt)))
    .groupBy(mealHistory.mealId);
  const servesInWindow = new Map(recentServes.map((r) => [r.mealId, Number(r.count)]));

  const yesterday = await getPlannedMeal(addDaysToDateString(date, -1));
  const [spentThisWeek, firstShopSpentThisWeek] = await spendTotals(date);

  const scoreList = await scoreMealsForTonight(approvedMeals, context);
  const scores = scoreList ? new Map(approvedMeals.map((m, i) => [m.id, scoreList[i]])) : null;

  const decision = decideTonightsDinner({
    portions,
    approvedMeals,
    servesInWindow,
    yesterdaysProtein: yesterday?.primaryProtein ?? null,
    spentThisWeek,
    weeklyBudget: WEEKLY_BUDGET_GBP,
    scores,
  });
  if (!decision) return null;

  const chosen = decision.meal;
  const cost = costForPortions(chosen, portions);
  const firstShop = firstShopCostForPortions(chosen, portions);

  // Snapshot feature values as they are right now — weather can't be
  // re-fetched for a past date, and pantry/recency drift, so a training
  // example has to record the world as it was when the call was made.
  const [overlap, ingredientCount, lastServed, proteinLastServed] = await Promise.all([
    pantryOverlapGrams(chosen.id),
    countIngredients(chosen.id),
    daysSinceLastServed(chosen.id, date),
    proteinDaysSinceLastServed(chosen.primaryProtein, date),
  ]);

  await db.insert(mealHistory).values({
    mealId: chosen.id,
    primaryProtein: chosen.primaryProtein,
    servedDate: date,
    portions,
    costIncurred: cost !== null ? String(cost) : null,
    firstShopCost: firstShop !== null ? String(firstShop) : null,
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
    planDate: date,
    portions,
    cost,
    firstShopCost: firstShop,
    context,
    alreadySelectedToday: false,
    relaxedProteinRule: decision.relaxedProteinRule,
    relaxedRepeatRule: decision.relaxedRepeatRule,
    relaxedBudgetRule: decision.relaxedBudgetRule,
    usedModel: decision.usedModel,
    spentThisWeekGBP: spentThisWeek + (cost ?? 0),
    firstShopSpentThisWeekGBP: firstShopSpentThisWeek + (firstShop ?? 0),
  };
}

/** Today's dinner (Europe/London). */
export function selectTonightsDinner(now: Date = new Date()): Promise<RotationResult | null> {
  return planMealForDate(londonDateString(now), { now });
}

/**
 * Marks the current plan for `date` as superseded and picks a replacement,
 * excluding everything already rejected for that date. The superseded row
 * is kept — it carries a real "declined in this context" training label.
 */
export async function replacePlanForDate(date: string): Promise<RotationResult | null> {
  const rejected = await db
    .select({ mealId: mealHistory.mealId })
    .from(mealHistory)
    .where(eq(mealHistory.servedDate, date));

  await db
    .update(mealHistory)
    .set({ supersededAt: new Date() })
    .where(and(eq(mealHistory.servedDate, date), isNull(mealHistory.supersededAt)));

  return planMealForDate(date, { excludeMealIds: rejected.map((r) => r.mealId) });
}


/** [marginal, firstShop] spend so far this calendar week, excluding `today`. */
async function spendTotals(today: string): Promise<[number, number]> {
  return Promise.all([spentInWeek(today), spentInWeek(today, "firstShop")]);
}

async function approvedMealRecords(): Promise<MealRecord[]> {
  const rows = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(isNull(meals.deletedAt));
  const seen = new Map<number, MealRecord>();
  for (const r of rows) seen.set(r.meal.id, r.meal);
  return [...seen.values()];
}

async function countIngredients(mealId: number): Promise<number> {
  const rows = await db.query.mealIngredients.findMany({ where: eq(mealIngredients.mealId, mealId) });
  return rows.length;
}

export async function daysSinceLastServed(mealId: number, asOfDate: string): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(
      and(
        eq(mealHistory.mealId, mealId),
        sql`${mealHistory.servedDate} < ${asOfDate}`,
        isNull(mealHistory.supersededAt)
      )
    );
  return mostRecentGap(rows.map((r) => r.servedDate), asOfDate);
}

export async function proteinDaysSinceLastServed(
  protein: string,
  asOfDate: string
): Promise<number | null> {
  const rows = await db
    .select({ servedDate: mealHistory.servedDate })
    .from(mealHistory)
    .where(
      and(
        eq(mealHistory.primaryProtein, protein),
        sql`${mealHistory.servedDate} < ${asOfDate}`,
        isNull(mealHistory.supersededAt)
      )
    );
  return mostRecentGap(rows.map((r) => r.servedDate), asOfDate);
}

function mostRecentGap(dates: string[], asOfDate: string): number | null {
  if (dates.length === 0) return null;
  const mostRecent = dates.reduce((a, b) => (a > b ? a : b));
  return Math.round((Date.parse(asOfDate) - Date.parse(mostRecent)) / (1000 * 60 * 60 * 24));
}
