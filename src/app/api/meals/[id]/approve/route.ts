import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { approvedQueue } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const mealId = Number(params.id);
  if (!Number.isInteger(mealId)) {
    return NextResponse.json({ error: "Invalid meal id" }, { status: 400 });
  }
  await db.insert(approvedQueue).values({ mealId });
  return NextResponse.json({ ok: true });
}
