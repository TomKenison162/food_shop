import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals, approvedQueue, mealRejections } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Swipe-deck feed: excludes already-approved meals and soft-deleted
 * (swiped-left) ones. Meals are swipeable before they're priced (cost/tier
 * come from a manually-triggered pricing step on the *approved* queue) — so
 * the tier filter only narrows to meals that already have a tier; it never
 * hides unpriced meals when no tier filter (or "all") is selected.
 * `portions` only affects which price the client displays; tier is a fixed
 * property of the meal, not of the chosen portion size.
 */
export async function GET(req: NextRequest) {
  const userId = requireUserParam(req);
  // Exclusions are this user's own: the catalogue is shared, so another
  // person's left-swipe must not shrink this deck.
  const rejected = await db
    .select({ mealId: mealRejections.mealId })
    .from(mealRejections)
    .where(eq(mealRejections.userId, userId));
  const rejectedIds = rejected.map((r) => r.mealId);
  const tier = req.nextUrl.searchParams.get("tier"); // "budget" | "standard" | "gourmet" | null

  const approvedIds = (await db.select({ id: approvedQueue.mealId }).from(approvedQueue).where(eq(approvedQueue.userId, userId))).map(
    (r) => r.id
  );

  const conditions = [isNull(meals.deletedAt)];
  if (approvedIds.length > 0) conditions.push(notInArray(meals.id, approvedIds));
  // rejectedIds was being fetched and then silently dropped here — every
  // previously-rejected meal kept reappearing in the deck on every load.
  if (rejectedIds.length > 0) conditions.push(notInArray(meals.id, rejectedIds));
  if (tier === "budget" || tier === "standard" || tier === "gourmet") {
    conditions.push(eq(meals.tier, tier));
  }

  const deck = await db
    .select()
    .from(meals)
    .where(and(...conditions))
    .limit(50);

  return NextResponse.json({ meals: deck });
}
