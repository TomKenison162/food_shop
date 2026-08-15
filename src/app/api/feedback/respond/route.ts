import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { mealHistory } from "@/lib/db/schema";
import { verifyFeedbackLink } from "@/lib/feedbackLink";
import { trainModel } from "@/lib/ml/model";

export const dynamic = "force-dynamic";

function htmlPage(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Food Shop</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body{font-family:system-ui,sans-serif;background:#030712;color:#f3f4f6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}</style>
    </head><body><p>${message}</p></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

/**
 * The Yes/No links clicked from the daily email — the real, continuous
 * training signal for the ranking model. Labels the meal_history row for
 * that date (which already holds the feature context, snapshotted when the
 * suggestion was made) and retrains immediately, so the model keeps
 * improving day by day.
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
    return htmlPage("That link looks malformed.");
  }

  if (!verifyFeedbackLink({ mealId, date, accepted }, sig)) {
    return htmlPage("That link isn't valid.");
  }

  const row = await db.query.mealHistory.findFirst({
    where: and(eq(mealHistory.servedDate, date), eq(mealHistory.mealId, mealId)),
  });
  if (!row) {
    return htmlPage("No dinner was recorded for that date.");
  }
  if (row.accepted !== null) {
    return htmlPage("Already recorded — thanks.");
  }

  await db
    .update(mealHistory)
    .set({ accepted, respondedAt: new Date() })
    .where(eq(mealHistory.id, row.id));

  const trainResult = await trainModel();

  return htmlPage(
    `${accepted ? "Noted — glad it landed." : "Noted — thanks."} ${
      trainResult.trained
        ? `Model retrained on ${trainResult.sampleCount} replies.`
        : "Not enough replies to train the model yet."
    }`
  );
}
