import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { meals, mealHistory } from "@/lib/db/schema";
import { verifyFeedbackLink } from "@/lib/feedbackLink";
import { recordMealCooked } from "@/lib/pantry/pantry";
import { sendDinnerReminder } from "@/lib/email/sendReminder";
import { getPlannedMeal, replacePlanForDate } from "@/lib/rotation";

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
        ol{text-align:left;color:#d1d5db}
        a.btn{display:inline-block;background:#f3f4f6;color:#111827;padding:10px 20px;
              border-radius:999px;text-decoration:none;margin:4px}
        a.btn.secondary{background:#374151;color:#f3f4f6}
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

/**
 * The Yes/No links from the daily email — the model's real training signal.
 * Labels the meal_history row for that date (which already holds the
 * feature context, snapshotted when the suggestion was made).
 *
 * A "No" supersedes the plan and emails a different dinner, because "not
 * that" without an alternative leaves you exactly where you started. The
 * declined row is kept as a genuine negative training example.
 *
 * Two things are deliberately NOT done here, because this route runs while
 * someone is staring at a loading spinner:
 *  - Retraining. trainModel() runs leave-one-out CV, i.e. one full XGBoost
 *    fit per labelled example, which blew past the function timeout — the
 *    click appeared to hang, and re-clicking hit the "already replaced"
 *    path below. It now runs in the daily cron instead.
 *  - Rendering the replacement inline. The alternative goes out by email so
 *    it's on your phone at the shop, not stuck in a browser tab.
 *
 * Exempt from the login gate (see src/middleware.ts): it's clicked from an
 * email client with no session, and is authenticated by its HMAC signature.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mealId = Number(sp.get("mealId"));
  const date = sp.get("date") ?? "";
  const accepted = sp.get("accepted") === "true";
  const sig = sp.get("sig") ?? "";

  if (!Number.isInteger(mealId) || !date) {
    return htmlPage("<p>That link looks malformed.</p>");
  }
  if (!verifyFeedbackLink({ mealId, date, accepted }, sig)) {
    return htmlPage("<p>That link isn't valid.</p>");
  }

  const row = await db.query.mealHistory.findFirst({
    where: and(
      eq(mealHistory.servedDate, date),
      eq(mealHistory.mealId, mealId),
      isNull(mealHistory.supersededAt)
    ),
  });

  // Emails don't expire, so the same link gets clicked twice often —
  // impatiently, or days later. Both dead ends below used to say only that
  // the link was spent, which reads like a failure. Say what's actually
  // planned instead, so a stale click is still informative.
  if (!row || row.accepted !== null) {
    const current = await livePlanName(date);
    const heading = !row ? "Already replaced." : "Already recorded.";
    return htmlPage(
      `<h1>${heading}</h1>` +
        (current
          ? `<p>Tonight's plan is <strong>${esc(current)}</strong> — check your inbox for the full email.</p>`
          : `<p>There's no dinner planned for ${esc(date)} right now.</p>`)
    );
  }

  await db
    .update(mealHistory)
    .set({ accepted, respondedAt: new Date() })
    .where(eq(mealHistory.id, row.id));

  if (accepted) {
    // The only point at which the app knows real food was bought and cooked.
    await recordMealCooked(mealId);
    return htmlPage(`<h1>Enjoy.</h1><p>Noted — glad it landed.</p>`);
  }

  // Declined: pick a genuine alternative rather than leaving them stuck.
  const replacement = await replacePlanForDate(date);
  if (!replacement) {
    return htmlPage(
      `<h1>Noted.</h1><p>Nothing else in your queue fits today's rules — you're on your own tonight.</p>`
    );
  }

  const emailResult = await sendDinnerReminder(replacement);
  if (!emailResult.sent) {
    return htmlPage(
      `<h1>${esc(replacement.meal.name)}</h1>
       <p>That's your new suggestion, but the email didn't go out: ${esc(
         emailResult.reason ?? "unknown reason"
       )}</p>`
    );
  }

  // Stamp the replacement as emailed, or the 17:00 run would find an
  // un-emailed plan for today and send the same meal a second time.
  const fresh = await getPlannedMeal(date);
  if (fresh) {
    await db.update(mealHistory).set({ emailedAt: new Date() }).where(eq(mealHistory.id, fresh.id));
  }

  return htmlPage(`
    <h1>New one sent.</h1>
    <p><strong>${esc(replacement.meal.name)}</strong> is on its way to your inbox, with the method and shopping list.</p>
  `);
}
