import { NextRequest, NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals, approvedQueue, rejectedMeals } from "@/lib/db/schema";

/**
 * Swipe-deck feed: excludes meals already approved or rejected. Meals are
 * swipeable before they're priced (cost/tier come from a manually-triggered
 * pricing step on the *approved* queue, not from generation) — so the tier
 * filter only narrows to meals that already have a tier; it never hides
 * unpriced meals when no tier filter (or "all") is selected. `portions`
 * only affects which price the client displays; tier is a fixed property
 * of the meal, not of the chosen portion size.
 */
export async function GET(req: NextRequest) {
  const tier = req.nextUrl.searchParams.get("tier"); // "budget" | "standard" | "gourmet" | null

  const decidedIds = await Promise.all([
    db.select({ id: approvedQueue.mealId }).from(approvedQueue),
    db.select({ id: rejectedMeals.mealId }).from(rejectedMeals),
  ]);
  const excluded = [...decidedIds[0], ...decidedIds[1]].map((r) => r.id);

  const conditions = [];
  if (excluded.length > 0) conditions.push(notInArray(meals.id, excluded));
  if (tier === "budget" || tier === "standard" || tier === "gourmet") {
    conditions.push(eq(meals.tier, tier));
  }

  const deck = await db
    .select()
    .from(meals)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(50);

  return NextResponse.json({ meals: deck });
}
