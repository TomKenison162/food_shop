import { requireUserId } from "./userGuard";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "./db/client";
import { mealHistory } from "./db/schema";
import { startOfWeek } from "./date";

/**
 * Spend so far in the calendar week (Mon-Sun) containing `today`, excluding
 * today itself and any superseded (declined-and-replaced) plans.
 *
 * Calendar week rather than a trailing 7 days because "£100 a week"
 * normally means a week that resets, not a window that never does — with a
 * rolling window an expensive Saturday keeps suppressing choices until the
 * following Saturday.
 *
 * `basis` picks which cost is summed:
 *  - "marginal"  — value of food actually consumed; what the budget caps
 *  - "firstShop" — whole-pack totals; closer to what the till charges in a
 *                  week where you're restocking staples
 */
export async function spentInWeek(
  userId: number,
  today: string,
  basis: "marginal" | "firstShop" = "marginal"
): Promise<number> {
  const weekStart = startOfWeek(today);
  const column = basis === "marginal" ? mealHistory.costIncurred : mealHistory.firstShopCost;
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${column}), 0)` })
    .from(mealHistory)
    .where(
      and(
      eq(mealHistory.userId, requireUserId(userId, "spentInWeek")),
        gte(mealHistory.servedDate, weekStart),
        lt(mealHistory.servedDate, today),
        isNull(mealHistory.supersededAt)
      )
    );
  return Number(rows[0]?.total ?? 0);
}
