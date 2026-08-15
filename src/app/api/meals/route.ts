import { NextRequest, NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals, approvedQueue } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Swipe-deck feed: excludes already-approved meals. Rejected meals are hard-
 * deleted on swipe-left (see /api/meals/[id]/reject), so there's nothing to
 * exclude for those — they're just gone from `meals` entirely. Meals are
 * swipeable before they're priced (cost/tier come from a manually-triggered
 * pricing step on the *approved* queue, not from generation) — so the tier
 * filter only narrows to meals that already have a tier; it never hides
 * unpriced meals when no tier filter (or "all") is selected. `portions`
 * only affects which price the client displays; tier is a fixed property
 * of the meal, not of the chosen portion size.
 */
export async function GET(req: NextRequest) {
  const tier = req.nextUrl.searchParams.get("tier"); // "budget" | "standard" | "gourmet" | null

  const approvedIds = (await db.select({ id: approvedQueue.mealId }).from(approvedQueue)).map(
    (r) => r.id
  );

  const conditions = [];
  if (approvedIds.length > 0) conditions.push(notInArray(meals.id, approvedIds));
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
