import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals } from "@/lib/db/schema";

/** Onboarding grid: the curated set of classic dishes new users tap to seed their queue. */
export async function GET() {
  const classics = await db.select().from(meals).where(eq(meals.isClassic, true));
  return NextResponse.json({ meals: classics });
}
