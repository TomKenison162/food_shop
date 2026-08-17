import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { db } from "@/lib/db/client";
import { approvedQueue } from "@/lib/db/schema";
import { priceMealIfNeeded } from "@/lib/pricing/priceApproved";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = requireUserParam(req);
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db.insert(approvedQueue).values({ userId, mealId });

  // Price it now that it can actually be chosen. Costs nothing for a meal
  // whose ingredients other dishes already resolved, so the bill scales with
  // how novel a meal is rather than with how much swiping happens.
  //
  // Never block the approval on it: a pricing failure must not cost you the
  // swipe, and an unpriced meal is still selectable — the rotation rules
  // skip the budget check for meals with no cost, and the daily run prices
  // any stragglers before the email goes out.
  let pricing: Awaited<ReturnType<typeof priceMealIfNeeded>> | { error: string };
  try {
    pricing = await priceMealIfNeeded(mealId);
  } catch (err) {
    pricing = { error: err instanceof Error ? err.message : String(err) };
  }

  return NextResponse.json({ ok: true, pricing });
}
