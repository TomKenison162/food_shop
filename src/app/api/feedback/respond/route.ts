import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals, mealHistory } from "@/lib/db/schema";
import { verifyFeedbackLink, type FeedbackAction } from "@/lib/feedbackLink";
import { DECLINE_LABELS, isDeclineReason, wantsReplacement, type DeclineReason } from "@/lib/declineReasons";
import { recordMealCooked } from "@/lib/pantry/pantry";
import { logFeedbackEvent } from "@/lib/eventLog";
import { sendDinnerReminder } from "@/lib/email/sendReminder";
import {
  offerContext,
  getPlannedMeal,
  offerGroupFor,
  replacePlanForDate,
  resolveOffer,
  resolveOfferAsDeclined,
  setPlanForDate,
  type RotationResult,
} from "@/lib/rotation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function htmlPage(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Food Shop</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:system-ui,sans-serif;background:#030712;color:#f3f4f6;display:flex;
             align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
        .card{max-width:32rem}
        h1{font-size:1.5rem;margin:0 0 .5rem}
        p{color:#9ca3af;line-height:1.5}
      </style>
    </head><body><div class="card">${body}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** What's currently planned for `date`, for pages that need to say so. */
async function livePlanName(date: string): Promise<string | null> {
  const plan = await getPlannedMeal(date);
  if (!plan) return null;
  const meal = await db.query.meals.findFirst({ where: eq(meals.id, plan.mealId) });
  return meal?.name ?? null;
}

/** Emails the full detail for a newly-committed plan and stamps it as sent. */
async function emailPlan(result: RotationResult, date: string): Promise<string | null> {
  const sent = await sendDinnerReminder(result);
  if (!sent.sent) return sent.reason ?? "unknown reason";
  const fresh = await getPlannedMeal(date);
  if (fresh) {
    await db.update(mealHistory).set({ emailedAt: new Date() }).where(eq(mealHistory.id, fresh.id));
  }
  return null;
}

/**
 * The daily email's buttons — and the entire training signal for the model.
 *
 * Three actions, because a single accept/decline bit was too coarse to learn
 * from. "No" used to mean any of: not fancying the dish, it being too
 * expensive, too much effort, or simply not being home — and a model fed the
 * union of those learns none of them, which is why it kept failing the
 * baseline gate.
 *
 *  - accept  : the meal led with was cooked
 *  - choose  : an alternative was preferred, which labels the whole offer
 *              group at once (one winner, the rest genuine losers under an
 *              identical context)
 *  - decline : none of them, with a reason. "not_home" is recorded but never
 *              trained on — it says nothing about food.
 *
 * Deliberately does no model training: leave-one-out CV is far too slow for
 * a request someone is waiting on (it used to time out here). The daily cron
 * retrains instead.
 *
 * Exempt from the login gate (see src/middleware.ts): clicked from an email
 * client with no session, authenticated by the HMAC signature.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mealId = Number(sp.get("mealId"));
  const date = sp.get("date") ?? "";
  const action = (sp.get("action") ?? "") as FeedbackAction;
  const rawReason = sp.get("reason");
  const rawRating = sp.get("rating");
  const sig = sp.get("sig") ?? "";

  if (!Number.isInteger(mealId) || !date || !["accept", "choose", "decline"].includes(action)) {
    return htmlPage("<p>That link looks malformed.</p>");
  }

  const reason: DeclineReason | null =
    rawReason && isDeclineReason(rawReason) ? rawReason : null;
  if (action === "decline" && !reason) {
    return htmlPage("<p>That link looks malformed.</p>");
  }
  const rating = rawRating !== null && /^[1-5]$/.test(rawRating) ? Number(rawRating) : null;
  if (rawRating !== null && rating === null) {
    return htmlPage("<p>That link looks malformed.</p>");
  }
  if (!verifyFeedbackLink({ mealId, date, action, reason, rating }, sig)) {
    return htmlPage("<p>That link isn't valid.</p>");
  }

  const offerGroup = await offerGroupFor(date, mealId);
  const live = await getPlannedMeal(date);

  // Wide capture, never trained on. Reply latency in particular cannot be
  // reconstructed afterwards, and a reply two minutes after the email
  // plausibly means something different from one at 11pm.
  const offered = offerGroup ? await offerContext(offerGroup, mealId) : null;
  await logFeedbackEvent({
    offerGroup,
    servedDate: date,
    mealId,
    action,
    reason,
    emailedAt: live?.emailedAt ?? null,
    userAgent: req.headers.get("user-agent"),
    offeredPosition: offered?.position ?? null,
    offeredCount: offered?.count ?? null,
    chosenScore: null,
  });

  // --- an alternative was preferred ---------------------------------------
  if (action === "choose") {
    if (live?.mealId === mealId) {
      return htmlPage(`<h1>Already set.</h1><p>That's tonight's plan already.</p>`);
    }
    if (offerGroup) await resolveOffer(offerGroup, mealId);

    const result = await setPlanForDate(date, mealId);
    if (!result) return htmlPage("<p>That meal isn't available any more.</p>");

    const failure = await emailPlan(result, date);
    return htmlPage(
      failure
        ? `<h1>${esc(result.meal.name)}</h1><p>Set as tonight's dinner, but the email didn't go out: ${esc(failure)}</p>`
        : `<h1>${esc(result.meal.name)} it is.</h1><p>The full recipe and shopping list are on their way to your inbox.</p>`
    );
  }

  // --- accept / decline both label the live plan row -----------------------
  const row = await db.query.mealHistory.findFirst({
    where: and(
      eq(mealHistory.servedDate, date),
      eq(mealHistory.mealId, mealId),
      isNull(mealHistory.supersededAt)
    ),
  });

  // Emails don't expire, so the same link gets clicked twice often —
  // impatiently, or days later. Say what's actually planned rather than
  // dead-ending on a spent link.
  if (!row || row.accepted !== null) {
    const current = await livePlanName(date);
    return htmlPage(
      `<h1>${!row ? "Already replaced." : "Already recorded."}</h1>` +
        (current
          ? `<p>Tonight's plan is <strong>${esc(current)}</strong>. The full email is in your inbox.</p>`
          : `<p>There's no dinner planned for ${esc(date)} right now.</p>`)
    );
  }

  if (action === "accept") {
    await db
      .update(mealHistory)
      .set({ accepted: true, rating, respondedAt: new Date() })
      .where(eq(mealHistory.id, row.id));
    if (offerGroup) await resolveOffer(offerGroup, mealId);
    // The one point at which the app knows real food was bought and cooked.
    await recordMealCooked(mealId);
    const note =
      rating === null ? "Noted."
      : rating >= 4 ? "Noted, one to repeat."
      : rating <= 2 ? "Noted. It'll come round less often."
      : "Noted.";
    return htmlPage(`<h1>Enjoy.</h1><p>${note}</p>`);
  }

  // --- declined, with a reason --------------------------------------------
  await db
    .update(mealHistory)
    .set({ accepted: false, declineReason: reason, respondedAt: new Date() })
    .where(eq(mealHistory.id, row.id));
  if (offerGroup) await resolveOfferAsDeclined(offerGroup);

  // Some declines settle dinner rather than reject the dish. Suggesting an
  // alternative to someone who is out, or who is about to eat yesterday's
  // chilli, is noise — and neither says anything about the meal, so neither
  // becomes a training label.
  if (!wantsReplacement(reason!)) {
    if (reason === "have_leftovers") {
      await db.update(mealHistory).set({ ateLeftovers: true }).where(eq(mealHistory.id, row.id));
    }
    const mealName =
      (await db.query.meals.findFirst({ where: eq(meals.id, mealId) }))?.name ?? "the meal";
    return htmlPage(
      reason === "have_leftovers"
        ? `<h1>Leftovers it is.</h1><p>Nothing else suggested tonight, and this won't count against ${esc(mealName)}.</p>`
        : `<h1>Have a good evening.</h1><p>Nothing else suggested tonight, and this won't count against ${esc(mealName)}.</p>`
    );
  }

  const replacement = await replacePlanForDate(date);
  if (!replacement) {
    return htmlPage(
      `<h1>Noted: ${esc(DECLINE_LABELS[reason!].toLowerCase())}.</h1>
       <p>Nothing else in your queue fits today's rules, so you're on your own tonight.</p>`
    );
  }

  const failure = await emailPlan(replacement, date);
  return htmlPage(
    failure
      ? `<h1>${esc(replacement.meal.name)}</h1><p>That's your new suggestion, but the email didn't go out: ${esc(failure)}</p>`
      : `<h1>New one sent.</h1>
         <p><strong>${esc(replacement.meal.name)}</strong> is on its way to your inbox, with the method and shopping list.</p>`
  );
}
