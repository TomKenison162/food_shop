import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mealHistory } from "@/lib/db/schema";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { getPlannedMeal, selectTonightsDinner } from "@/lib/rotation";
import { sendDinnerReminder, sendFailureAlert } from "@/lib/email/sendReminder";
import { londonDateString, londonHour } from "@/lib/date";
import { isPaused } from "@/lib/settings";
import { purgeStalePantryItems } from "@/lib/pantry/pantry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEND_HOUR = 17;

/**
 * Polled hourly (by .github/workflows/daily-reminder-cron.yml; vercel.json
 * also registers a daily backup). Vercel Cron runs in UTC and the UK shifts
 * between GMT and BST, so the 17:00 check happens here against Europe/London
 * wall-clock time rather than being baked into a cron expression that would
 * need hand-adjusting twice a year.
 *
 * Sends at or after SEND_HOUR rather than only exactly at it, so a poll
 * that's late still delivers that day rather than silently skipping.
 * Re-sending is prevented by the emailedAt stamp, not by the plan existing —
 * the weekly planner may well have chosen today's meal days ago.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hour = londonHour();
  if (hour < SEND_HOUR) {
    return NextResponse.json({
      skipped: true,
      reason: `Before ${SEND_HOUR}:00 Europe/London (it's ${hour}:00).`,
    });
  }

  const today = londonDateString();

  try {
    if (await isPaused(today)) {
      return NextResponse.json({ skipped: true, reason: "Reminders are paused." });
    }

    // Expired leftovers would otherwise show up as "you already have this".
    await purgeStalePantryItems(today);

    const existing = await getPlannedMeal(today);
    if (existing?.emailedAt) {
      return NextResponse.json({ skipped: true, reason: "Already emailed today." });
    }

    const result = await selectTonightsDinner();
    if (!result) {
      return NextResponse.json({ sent: false, reason: "Approved queue is empty." });
    }

    const emailResult = await sendDinnerReminder(result);
    if (!emailResult.sent) {
      await sendFailureAlert(`Daily email not sent: ${emailResult.reason ?? "unknown reason"}`);
      return NextResponse.json({ meal: result.meal.name, ...emailResult }, { status: 500 });
    }

    await db
      .update(mealHistory)
      .set({ emailedAt: new Date() })
      .where(eq(mealHistory.id, (await getPlannedMeal(today))!.id));

    return NextResponse.json({ meal: result.meal.name, ...emailResult });
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await sendFailureAlert(message);
    // Non-2xx so the GitHub Actions `curl -sf` step fails loudly too.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
