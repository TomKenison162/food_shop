import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvedQueue, meals } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = requireUserParam(req);
  const rows = await db
    .select({ meal: meals, approvedAt: approvedQueue.approvedAt })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id));

  return NextResponse.json({ queue: rows });
}
