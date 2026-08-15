import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { selectTonightsDinner } from "@/lib/rotation";
import { sendDinnerReminder, sendFailureAlert } from "@/lib/email/sendReminder";
import { londonHour } from "@/lib/date";

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
 * that's late — a missed CI window, a laptop asleep at 5pm — still delivers
 * that day rather than silently skipping. Idempotency comes from
 * selectTonightsDinner being once-per-day: the `alreadySelectedToday` guard
 * is what stops the hourly poll re-sending all evening.
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

  try {
    const result = await selectTonightsDinner();
    if (!result) {
      return NextResponse.json({ sent: false, reason: "Approved queue is empty." });
    }
    if (result.alreadySelectedToday) {
      return NextResponse.json({
        skipped: true,
        reason: "Already emailed today.",
        meal: result.meal.name,
      });
    }

    const emailResult = await sendDinnerReminder(result);
    if (!emailResult.sent) {
      await sendFailureAlert(`Email not sent: ${emailResult.reason ?? "unknown reason"}`);
      return NextResponse.json({ meal: result.meal.name, ...emailResult }, { status: 500 });
    }
    return NextResponse.json({ meal: result.meal.name, ...emailResult });
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await sendFailureAlert(message);
    // Non-2xx so the GitHub Actions `curl -sf` step fails loudly too.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
