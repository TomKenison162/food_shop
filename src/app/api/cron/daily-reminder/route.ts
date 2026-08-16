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
import { trainModel } from "@/lib/ml/model";
import { priceApprovedMeals } from "@/lib/pricing/priceApproved";

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

  // ?force=1 sends immediately, ignoring the time window, the pause setting
  // and the already-emailed guard. Without it the only way to prove the
  // whole chain works is to wait until 17:00 and hope — and a legitimate
  // "skipped, too early" response is indistinguishable from a broken
  // deployment. Still requires CRON_SECRET, so it isn't publicly callable.
  const force = req.nextUrl.searchParams.get("force") === "1";

  const hour = londonHour();
  if (!force && hour < SEND_HOUR) {
    return NextResponse.json({
      skipped: true,
      reason: `Before ${SEND_HOUR}:00 Europe/London (it's ${hour}:00).`,
    });
  }

  const today = londonDateString();

  try {
    if (!force && (await isPaused(today))) {
      return NextResponse.json({ skipped: true, reason: "Reminders are paused." });
    }

    // Expired leftovers would otherwise show up as "you already have this".
    await purgeStalePantryItems(today);

    // Catch anything approved before on-demand pricing existed, or whose
    // pricing failed at approval time. A no-op (and free) when the whole
    // queue is already priced, which is the normal case — it exists so the
    // budget and tier rules never have to reason about a NULL cost, and so
    // the email never goes out with a missing shopping-list total.
    const pricing = await priceApprovedMeals();

    // Retrain before choosing, so tonight's pick uses every reply so far.
    // This lives here rather than in the feedback route because
    // leave-one-out CV fits one model per labelled example and easily
    // outruns a request someone is waiting on. A training failure must not
    // cost you dinner, so it's swallowed — selection falls back to the rules.
    let training: string | undefined;
    try {
      const t = await trainModel();
      training = t.trained
        ? `Retrained on ${t.sampleCount} replies (${((t.accuracy ?? 0) * 100).toFixed(0)}% vs ${((t.baselineAccuracy ?? 0) * 100).toFixed(0)}% baseline).`
        : t.reason;
    } catch (err) {
      training = `Training failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const existing = await getPlannedMeal(today);
    if (!force && existing?.emailedAt) {
      return NextResponse.json({ skipped: true, reason: "Already emailed today." });
    }

    const result = await selectTonightsDinner();
    if (!result) {
      return NextResponse.json({ sent: false, reason: "Approved queue is empty.", training });
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

    return NextResponse.json({ meal: result.meal.name, ...emailResult, training, priced: pricing.pricedMealIds.length });
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await sendFailureAlert(message);
    // Non-2xx so the GitHub Actions `curl -sf` step fails loudly too.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
