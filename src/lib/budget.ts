import { and, gte, lt, eq, sql } from "drizzle-orm";
import { db } from "./db/client";
import { mealHistory } from "./db/schema";
import { addDaysToDateString } from "./date";

export const WEEKLY_BUDGET_GBP = 100;

/** Sum of costIncurred for the 6 days before `today` (a trailing 7-day window including today's pick). */
export async function spentInRollingWeek(today: string): Promise<number> {
  const windowStart = addDaysToDateString(today, -6);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${mealHistory.costIncurred}), 0)` })
    .from(mealHistory)
    .where(and(gte(mealHistory.servedDate, windowStart), lt(mealHistory.servedDate, today)));
  return Number(rows[0]?.total ?? 0);
}

export function costForPortions(
  meal: { costOnePerson: string | null; costTwoPerson: string | null },
  portions: 1 | 2
): number | null {
  const raw = portions === 1 ? meal.costOnePerson : meal.costTwoPerson;
  return raw !== null ? Number(raw) : null;
}
