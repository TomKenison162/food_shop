import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals } from "@/lib/db/schema";

/** Swipe-left is permanent: the meal (and its ingredients, cascade) is deleted, not just hidden. */
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db.delete(meals).where(eq(meals.id, mealId));
  return NextResponse.json({ ok: true });
}
