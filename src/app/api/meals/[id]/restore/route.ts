import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvedQueue, mealRejections } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Undo a swipe-left. Clears the soft-delete marker so the meal returns to the deck. */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = requireUserParam(req);
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db
    .delete(mealRejections)
    .where(and(eq(mealRejections.userId, userId), eq(mealRejections.mealId, mealId)));
  return NextResponse.json({ ok: true });
}
