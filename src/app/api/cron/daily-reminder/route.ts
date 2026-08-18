import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mealHistory } from "@/lib/db/schema";
import { isAuthorizedCronRequest } from "@/lib/auth/cron";
import { getPlannedMeal, selectTonightsDinner } from "@/lib/rotation";
import { sendDinnerReminder, sendFailureAlert } from "@/lib/email/sendReminder";
import { londonDateString, londonHour } from "@/lib/date";
import { purgeStalePantryItems } from "@/lib/pantry/pantry";
import { trainModel } from "@/lib/ml/model";
import { priceApprovedMeals } from "@/lib/pricing/priceApproved";
import { eventLogSummary } from "@/lib/eventLog";
import { activeUsers, isPaused, type UserRecord } from "@/lib/users";
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
  const onlyUser = req.nextUrl.searchParams.get("user");
  const allUsers = req.nextUrl.searchParams.get("all") === "1";

  // A forced run is, in practice, always someone testing or re-sending their
  // OWN reminder — but force also bypasses the already-emailed guard, so
  // without this a bare "?force=1" quietly re-sent to every active user at
  // once. One person resending their own dinner should never re-trigger
  // someone else's. The unforced scheduled poll is unaffected: it still
  // loops everyone, safely, because the already-emailed guard is what makes
  // that safe in the first place.
  if (force && !onlyUser && !allUsers) {
    return NextResponse.json(
      {
        error:
          "?force=1 requires either ?user=<id> (resend for one person) or ?all=1 " +
          "(explicitly resend for everyone). This prevents one person's resend " +
          "from silently re-sending everyone else's too.",
      },
      { status: 400 }
    );
  }

  try {
    // Everyone gets their own pass. One person's failure must never cost
    // another their dinner, so each is wrapped separately and a thrown error
    // is recorded against that user rather than aborting the run.
    const everyone = await activeUsers();
    const targets = onlyUser ? everyone.filter((u) => String(u.id) === onlyUser) : everyone;
    if (targets.length === 0) {
      return NextResponse.json({ error: onlyUser ? `No active user ${onlyUser}.` : "No active users." }, { status: 404 });
    }

    const results: Record<string, unknown>[] = [];
    for (const user of targets) {
      try {
        results.push(await runForUser(user, today, hour, force, useItUpParam, req));
      } catch (err) {
        const message = err instanceof Error ? err.stack ?? err.message : String(err);
        await sendFailureAlert(`Daily run failed for ${user.name} (${user.email}): ${message}`);
        results.push({ user: user.name, error: message });
      }
    }

    const anySent = results.some((r) => r.sent === true);
    return NextResponse.json({ users: results }, { status: anySent || results.every((r) => r.skipped) ? 200 : 500 });
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await sendFailureAlert(message);
    // Non-2xx so the GitHub Actions curl step fails loudly too.
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * One user's evening: guards first, then the work.
 *
 * Split out of the handler so the loop can isolate failures. Everything
 * optional inside is caught rather than thrown, for the same reason the
 * loop catches: the email is the product, and nothing else in here is
 * worth losing it over.
 */
async function runForUser(
  user: UserRecord,
  today: string,
  hour: number,
  force: boolean,
  useItUpParam: boolean,
  req: NextRequest
): Promise<Record<string, unknown>> {
  const userId = user.id;

  const existing = await getPlannedMeal(userId, today);
  if (!force && existing?.emailedAt) {
    return { user: user.name, skipped: true, reason: "Already emailed today.", emailedAt: existing.emailedAt };
  }
  if (!force && (await isPaused(userId, today))) {
    return { user: user.name, skipped: true, reason: "Reminders are paused." };
  }
  if (!force && hour < SEND_HOUR) {
    return { user: user.name, skipped: true, reason: `Before ${SEND_HOUR}:00 Europe/London (it's ${hour}:00).` };
  }

  const minutesLate = (hour - SEND_HOUR) * 60 + new Date().getUTCMinutes();
  const notes: Record<string, string> = {};
  const guard = async (name: string, fn: () => Promise<string | undefined>) => {
    try {
      const note = await fn();
      if (note) notes[name] = note;
    } catch (err) {
      notes[name] = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  await guard("pantry", async () => {
    const removed = await purgeStalePantryItems(userId, today);
    return removed > 0 ? `purged ${removed} expired` : undefined;
  });

  // Pricing is shared: the catalogue belongs to everyone, so whoever runs
  // first pays for any new matches and the rest inherit them free.
  await guard("pricing", async () => {
    const p = await priceApprovedMeals();
    return p.pricedMealIds.length > 0 ? `priced ${p.pricedMealIds.length} meals` : undefined;
  });

  await guard("training", async () => {
    const t = await trainModel(userId);
    return t.trained
      ? `retrained on ${t.sampleCount} examples (${((t.accuracy ?? 0) * 100).toFixed(0)}% vs ${((t.baselineAccuracy ?? 0) * 100).toFixed(0)}% baseline)`
      : t.reason;
  });

  const isSunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
  const result = await selectTonightsDinner(userId, { useItUp: useItUpParam || isSunday });
  if (!result) {
    await sendFailureAlert(`No dinner could be selected for ${user.name}: the approved queue is empty.`);
    return { user: user.name, sent: false, reason: "Approved queue is empty.", notes };
  }

  const emailResult = await sendDinnerReminder(userId, result);
  if (!emailResult.sent) {
    await sendFailureAlert(`Daily email not sent for ${user.name}: ${emailResult.reason ?? "unknown reason"}`);
    return { user: user.name, meal: result.meal.name, ...emailResult, notes };
  }

  const fresh = await getPlannedMeal(userId, today);
  if (fresh) {
    await db.update(mealHistory).set({ emailedAt: new Date() }).where(eq(mealHistory.id, fresh.id));
  }

  if (isSunday || req.nextUrl.searchParams.get("digest") === "1") {
    await guard("digest", async () => {
      const d = await sendWeeklyDigest(userId, today);
      return d.sent ? "sent" : `not sent: ${d.reason}`;
    });
  }

  return {
    user: user.name,
    meal: result.meal.name,
    ...emailResult,
    sentAtLondonHour: hour,
    minutesLate,
    notes,
    log: await eventLogSummary(userId),
  };
}
