import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvedQueue, mealRejections } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Swipe-left is a soft delete: the row (and its ingredients, and any
 * history referencing it) is kept, just marked deletedAt and filtered out
 * of the deck. A misswipe used to destroy a dish permanently — now it can
 * be undone via /api/meals/[id]/restore.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const userId = requireUserParam(req);
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  // Per-user, not a soft-delete on the shared catalogue: one person's
  // left-swipe must not remove a dish from anyone else's rotation.
  await db.insert(mealRejections).values({ userId, mealId }).onConflictDoNothing();
  await db
    .delete(approvedQueue)
    .where(and(eq(approvedQueue.userId, userId), eq(approvedQueue.mealId, mealId)));
  return NextResponse.json({ ok: true });
}
