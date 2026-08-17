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
import { eventLogSummary } from "@/lib/eventLog";
import { sendWeeklyDigest } from "@/lib/email/sendDigest";

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
  const useItUpParam = req.nextUrl.searchParams.get("useItUp") === "1";
  const today = londonDateString();
  const hour = londonHour();

  try {
    // --- cheap guards, in order of "is there anything to do at all" --------
    //
    // The question this job answers is "has today's reminder gone out yet,
    // and is it time?", so it is asked before any work happens. Previously
    // pricing and retraining ran first and the already-sent check came
    // after, which meant every hourly poll for the rest of the evening
    // re-ran the pricing pipeline — real API spend, and a fresh chance to
    // throw — long after the email had already been delivered.
    const existing = await getPlannedMeal(today);
    if (!force && existing?.emailedAt) {
      return NextResponse.json({
        skipped: true,
        reason: "Already emailed today.",
        emailedAt: existing.emailedAt,
      });
    }

    if (!force && (await isPaused(today))) {
      return NextResponse.json({ skipped: true, reason: "Reminders are paused." });
    }

    if (!force && hour < SEND_HOUR) {
      return NextResponse.json({
        skipped: true,
        reason: `Before ${SEND_HOUR}:00 Europe/London (it's ${hour}:00).`,
      });
    }

    // Past the hour with nothing sent, so send. How late is recorded because
    // scheduled workflows drift — GitHub delays them under load, and a run
    // an hour adrift looks identical to a broken one without this.
    const minutesLate = (hour - SEND_HOUR) * 60 + new Date().getUTCMinutes();

    // --- everything below is best-effort and must not block the email -----
    //
    // Each of these used to be able to abort the whole run. Pricing calls a
    // third-party API that has already been observed returning garbage, and
    // the digest is a nice-to-have; neither is worth losing dinner over.
    const notes: Record<string, string> = {};

    const guard = async (name: string, fn: () => Promise<string | undefined>) => {
      try {
        const note = await fn();
        if (note) notes[name] = note;
      } catch (err) {
        notes[name] = `failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    // Expired leftovers would otherwise show up as "you already have this".
    await guard("pantry", async () => {
      const removed = await purgeStalePantryItems(today);
      return removed > 0 ? `purged ${removed} expired` : undefined;
    });

    // Catches anything approved before on-demand pricing existed, or whose
    // pricing failed at approval time. Free and a no-op when the queue is
    // already priced, which is the normal case.
    await guard("pricing", async () => {
      const p = await priceApprovedMeals();
      return p.pricedMealIds.length > 0 ? `priced ${p.pricedMealIds.length} meals` : undefined;
    });

    // Retrain before choosing, so tonight's pick uses every reply so far.
    // This lives here rather than in the feedback route because leave-one-out
    // CV fits one model per labelled example and easily outruns a request
    // someone is waiting on.
    await guard("training", async () => {
      const t = await trainModel();
      return t.trained
        ? `retrained on ${t.sampleCount} examples (${((t.accuracy ?? 0) * 100).toFixed(0)}% vs ${((t.baselineAccuracy ?? 0) * 100).toFixed(0)}% baseline)`
        : t.reason;
    });

    // --- the part that actually matters -----------------------------------
    const isSunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
    const result = await selectTonightsDinner({ useItUp: useItUpParam || isSunday });
    if (!result) {
      await sendFailureAlert("No dinner could be selected: the approved queue is empty.");
      return NextResponse.json({ sent: false, reason: "Approved queue is empty.", notes });
    }

    const emailResult = await sendDinnerReminder(result);
    if (!emailResult.sent) {
      await sendFailureAlert(`Daily email not sent: ${emailResult.reason ?? "unknown reason"}`);
      return NextResponse.json({ meal: result.meal.name, ...emailResult, notes }, { status: 500 });
    }

    // Stamped only after a successful send, so a delivery failure is retried
    // by the next poll rather than being silently marked as done.
    const fresh = await getPlannedMeal(today);
    if (fresh) {
      await db.update(mealHistory).set({ emailedAt: new Date() }).where(eq(mealHistory.id, fresh.id));
    }

    // The weekly look-back goes out after the reminder, never before, so a
    // problem with it cannot cost you the thing you actually rely on.
    if (isSunday || req.nextUrl.searchParams.get("digest") === "1") {
      await guard("digest", async () => {
        const d = await sendWeeklyDigest(today);
        return d.sent ? "sent" : `not sent: ${d.reason}`;
      });
    }

    return NextResponse.json({
      meal: result.meal.name,
      ...emailResult,
      sentAtLondonHour: hour,
      minutesLate,
      notes,
      log: await eventLogSummary(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await sendFailureAlert(message);
    // Non-2xx so the GitHub Actions `curl -sf` step fails loudly too.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
