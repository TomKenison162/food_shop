import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mealHistory } from "@/lib/db/schema";
import { buildFeedbackLink, verifyFeedbackLink } from "@/lib/feedbackLink";
import { trainModel } from "@/lib/ml/model";
import { replacePlanForDate } from "@/lib/rotation";

export const dynamic = "force-dynamic";

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

/**
 * The Yes/No links from the daily email — the model's real training signal.
 * Labels the meal_history row for that date (which already holds the
 * feature context, snapshotted when the suggestion was made) and retrains.
 *
 * A "No" doesn't just record disappointment: it supersedes the plan and
 * immediately proposes a different dinner, because "not that" without an
 * alternative leaves you exactly where you started. The declined row is
 * kept as a genuine negative training example.
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
  if (!row) {
    return htmlPage("<p>That suggestion has already been replaced.</p>");
  }
  if (row.accepted !== null) {
    return htmlPage("<p>Already recorded — thanks.</p>");
  }

  await db
    .update(mealHistory)
    .set({ accepted, respondedAt: new Date() })
    .where(eq(mealHistory.id, row.id));

  const trainResult = await trainModel();
  const trainNote = trainResult.trained
    ? `<p>Model retrained on ${trainResult.sampleCount} replies.</p>`
    : `<p>${esc(trainResult.reason ?? "")}</p>`;

  if (accepted) {
    return htmlPage(`<h1>Enjoy.</h1><p>Noted — glad it landed.</p>${trainNote}`);
  }

  // Declined: offer a genuine alternative rather than leaving them stuck.
  const replacement = await replacePlanForDate(date);
  if (!replacement) {
    return htmlPage(
      `<h1>Noted.</h1><p>Nothing else in your queue fits today's rules — you're on your own tonight.</p>${trainNote}`
    );
  }

  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const linkParams = { mealId: replacement.meal.id, date };
  const yes = buildFeedbackLink(appUrl, { ...linkParams, accepted: true });
  const no = buildFeedbackLink(appUrl, { ...linkParams, accepted: false });

  return htmlPage(`
    <h1>How about ${esc(replacement.meal.name)}?</h1>
    <p>${esc(replacement.meal.description)}</p>
    <p>${replacement.portions} portion${replacement.portions === 2 ? "s" : ""}${
      replacement.cost !== null ? ` — £${replacement.cost.toFixed(2)}` : ""
    }</p>
    <ol>${replacement.meal.instructions.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
    <p>
      <a class="btn" href="${yes}">Yes, cooking this</a>
      <a class="btn secondary" href="${no}">No — try again</a>
    </p>
    ${trainNote}
  `);
}
