import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { dailyFeedback } from "@/lib/db/schema";
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
 * The Yes/No links clicked from the daily email. This is the real,
 * continuous training signal for the ranking model (see src/lib/ml/model.ts)
 * — every response retrains it immediately so it keeps improving day by day.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mealId = Number(sp.get("mealId"));
  const date = sp.get("date") ?? "";
  const dayOfWeek = Number(sp.get("dayOfWeek"));
  const isWeekend = sp.get("isWeekend") === "true";
  const temperatureCRaw = sp.get("temperatureC");
  const temperatureC = temperatureCRaw ? Number(temperatureCRaw) : null;
  const accepted = sp.get("accepted") === "true";
  const sig = sp.get("sig") ?? "";

  if (!Number.isInteger(mealId) || !date || Number.isNaN(dayOfWeek)) {
    return htmlPage("That link looks malformed.");
  }

  const valid = verifyFeedbackLink({ mealId, date, dayOfWeek, isWeekend, temperatureC, accepted }, sig);
  if (!valid) {
    return htmlPage("That link isn't valid.");
  }

  await db.insert(dailyFeedback).values({
    mealId,
    date,
    dayOfWeek,
    isWeekend,
    temperatureC: temperatureC !== null ? String(temperatureC) : null,
    accepted,
  });

  const trainResult = await trainModel();

  return htmlPage(
    accepted
      ? `Noted — glad it landed. ${trainResult.trained ? "Model retrained." : ""}`
      : `Noted — thanks. ${trainResult.trained ? "Model retrained." : ""}`
  );
}
