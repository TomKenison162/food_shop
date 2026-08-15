import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvedQueue, meals } from "@/lib/db/schema";

/** A random meal from the approved queue, for the local /train labeling page. */
export async function GET() {
  const rows = await db
    .select({ meal: meals })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id));

  if (rows.length === 0) {
    return NextResponse.json({ meal: null });
  }
  const choice = rows[Math.floor(Math.random() * rows.length)].meal;
  return NextResponse.json({ meal: choice });
}
