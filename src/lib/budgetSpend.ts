import { and, gte, lt, sql } from "drizzle-orm";
import { db } from "./db/client";
import { mealHistory } from "./db/schema";
import { startOfWeek } from "./date";

/**
 * Spend so far in the calendar week (Mon-Sun) containing `today`, excluding
 * today itself. Calendar week rather than a trailing 7 days because "£100 a
 * week" normally means a week that resets, not a window that never does —
 * with a rolling window an expensive Saturday keeps suppressing choices
 * until the following Saturday.
 */
export async function spentInWeek(today: string): Promise<number> {
  const weekStart = startOfWeek(today);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${mealHistory.costIncurred}), 0)` })
    .from(mealHistory)
    .where(and(gte(mealHistory.servedDate, weekStart), lt(mealHistory.servedDate, today)));
  return Number(rows[0]?.total ?? 0);
}
