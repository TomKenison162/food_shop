import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { rejectedMeals } from "@/lib/db/schema";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db.insert(rejectedMeals).values({ mealId });
  return NextResponse.json({ ok: true });
}
