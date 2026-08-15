import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

/** Onboarding grid: the curated set of classic dishes new users tap to seed their queue. */
export async function GET() {
  const classics = await db
    .select()
    .from(meals)
    .where(and(eq(meals.isClassic, true), isNull(meals.deletedAt)));
  return NextResponse.json({ meals: classics });
}
