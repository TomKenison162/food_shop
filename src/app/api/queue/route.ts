import { NextRequest, NextResponse } from "next/server";
import { requireUserParam } from "@/lib/userParam";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { approvedQueue, meals } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const userId = requireUserParam(req);
  // userId was being read and then never applied: this returned every
  // user's approved_queue rows joined together, unfiltered — one person's
  // queue page showed both households' approvals, duplicated wherever both
  // had approved the same meal.
  const rows = await db
    .select({ meal: meals, approvedAt: approvedQueue.approvedAt })
    .from(approvedQueue)
    .innerJoin(meals, eq(approvedQueue.mealId, meals.id))
    .where(eq(approvedQueue.userId, userId));

  return NextResponse.json({ queue: rows });
}
