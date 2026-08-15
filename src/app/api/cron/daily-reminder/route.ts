import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { selectTonightsDinner } from "@/lib/rotation";
import { sendDinnerReminder } from "@/lib/email/sendReminder";
import { londonHour } from "@/lib/date";

export const dynamic = "force-dynamic";

/**
 * Registered in vercel.json to run every hour ("0 * * * *"), not just at
 * 17:00. Vercel Cron schedules run in UTC, and the UK shifts between GMT
 * and BST — checking the Europe/London wall-clock hour here means the
 * reminder still fires at 5pm local time year-round without needing to
 * hand-adjust the cron expression for daylight saving.
 *
 * Locally, scripts/local-cron.ts polls this route every 5 minutes rather
 * than hourly — the `alreadySelectedToday` check below is what stops that
 * from re-sending the email on every poll within the 17:00 hour.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedCronRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hour = londonHour();
  if (hour !== 17) {
    return NextResponse.json({ skipped: true, reason: `Not 17:00 Europe/London (it's ${hour}:00).` });
  }

  const result = await selectTonightsDinner();
  if (!result) {
    return NextResponse.json({ sent: false, reason: "Approved queue is empty." });
  }
  if (result.alreadySelectedToday) {
    return NextResponse.json({ skipped: true, reason: "Already emailed today.", meal: result.meal.name });
  }

  const emailResult = await sendDinnerReminder(result);
  return NextResponse.json({ meal: result.meal.name, ...emailResult });
}
