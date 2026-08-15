import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvedQueue } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/**
 * Removes a meal from the approved queue without deleting it — it goes
 * back into the swipe deck to be decided on again.
 */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db.delete(approvedQueue).where(eq(approvedQueue.mealId, mealId));
  return NextResponse.json({ ok: true });
}
