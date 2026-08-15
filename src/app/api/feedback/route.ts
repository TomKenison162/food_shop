import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { dailyFeedback } from "@/lib/db/schema";
import { londonDateString } from "@/lib/date";

export const dynamic = "force-dynamic";

/**
 * Records a contextual yes/no training example — "given this day/weekend/
 * temperature, did this meal land." Distinct from approve/reject (general
 * preference) and from meal_history (what was actually served); this is
 * pure training signal for the ML ranking model, so multiple rows per day
 * are fine (e.g. the local /train page for quickly building a dataset).
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { mealId, dayOfWeek, isWeekend, temperatureC, accepted, date } = body;

  if (
    typeof mealId !== "number" ||
    typeof dayOfWeek !== "number" ||
    typeof isWeekend !== "boolean" ||
    typeof accepted !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid feedback payload" }, { status: 400 });
  }

  await db.insert(dailyFeedback).values({
    mealId,
    date: typeof date === "string" ? date : londonDateString(),
    dayOfWeek,
    isWeekend,
    temperatureC: typeof temperatureC === "number" ? String(temperatureC) : null,
    accepted,
  });

  return NextResponse.json({ ok: true });
}
