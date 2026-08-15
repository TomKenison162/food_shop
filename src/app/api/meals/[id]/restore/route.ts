import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Undo a swipe-left. Clears the soft-delete marker so the meal returns to the deck. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db.update(meals).set({ deletedAt: null }).where(eq(meals.id, mealId));
  return NextResponse.json({ ok: true });
}
