import { Resend } from "resend";
import { and, desc, eq, gte, isNotNull, lte } from "drizzle-orm";
import { db } from "../db/client";
import { meals, mealHistory, mlModel } from "../db/schema";
import { addDaysToDateString, londonDateString } from "../date";
import { WEEKLY_BUDGET_GBP } from "../budget";
import { DECLINE_LABELS, isDeclineReason } from "../declineReasons";

export interface SendDigestResult {
  sent: boolean;
  reason?: string;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mailer(): { resend: Resend; from: string; to: string } | null {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.REMINDER_FROM_EMAIL;
  const to = process.env.REMINDER_TO_EMAIL;
  if (!apiKey || !from || !to) return null;
  return { resend: new Resend(apiKey), from, to };
}

const META = 'style="color:#6b7280;font-size:14px"';

/**
 * The Sunday look-back: what got eaten, what it cost, and what the model
 * made of it.
 *
 * Exists because the app collects a great deal and shows almost none of it
 * back. A week is also the right window for the budget, which is the one
 * number that only makes sense in aggregate.
 */
export async function sendWeeklyDigest(today = londonDateString()): Promise<SendDigestResult> {
  const m = mailer();
  if (!m) return { sent: false, reason: "Email env vars not fully configured." };

  const weekStart = addDaysToDateString(today, -6);
  const rows = await db
    .select({ history: mealHistory, meal: meals })
    .from(mealHistory)
    .innerJoin(meals, eq(mealHistory.mealId, meals.id))
    .where(and(gte(mealHistory.servedDate, weekStart), lte(mealHistory.servedDate, today)))
    .orderBy(mealHistory.servedDate);

  const live = rows.filter((r) => r.history.supersededAt === null);
  const cooked = live.filter((r) => r.history.accepted === true);
  const spent = cooked.reduce((sum, r) => sum + Number(r.history.costIncurred ?? 0), 0);
  const till = cooked.reduce((sum, r) => sum + Number(r.history.firstShopCost ?? 0), 0);
  const rated = cooked.filter((r) => r.history.rating !== null);
  const avgRating = rated.length
    ? rated.reduce((s, r) => s + (r.history.rating ?? 0), 0) / rated.length
    : null;

  const declines = live.filter((r) => r.history.accepted === false);
  const reasonCounts = new Map<string, number>();
  for (const d of declines) {
    const r = d.history.declineReason;
    if (r && isDeclineReason(r)) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
  }

  const model = await db.query.mlModel.findFirst({ orderBy: desc(mlModel.trainedAt) });
  const labelled = await db
    .select({ id: mealHistory.id })
    .from(mealHistory)
    .where(isNotNull(mealHistory.accepted));

  const dayRows = live
    .map((r) => {
      const d = new Date(`${r.history.servedDate}T12:00:00Z`);
      const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
      const outcome =
        r.history.accepted === true
          ? `cooked${r.history.rating !== null ? ` &middot; ${r.history.rating}/5` : ""}`
          : r.history.accepted === false
            ? esc(DECLINE_LABELS[r.history.declineReason as keyof typeof DECLINE_LABELS] ?? "declined").toLowerCase()
            : "no reply";
      const cost = r.history.costIncurred !== null ? `£${Number(r.history.costIncurred).toFixed(2)}` : "";
      return `<tr><td style="padding:3px 12px 3px 0">${day}</td><td style="padding:3px 12px 3px 0">${esc(r.meal.name)}</td><td style="padding:3px 12px 3px 0;color:#6b7280">${outcome}</td><td style="padding:3px 0;color:#6b7280">${cost}</td></tr>`;
    })
    .join("");

  const best = [...rated].sort((a, b) => (b.history.rating ?? 0) - (a.history.rating ?? 0))[0];

  const modelLine = model
    ? `Trained on ${model.sampleCount} examples, scoring ${(Number(model.accuracy) * 100).toFixed(0)}% against a ${(Number(model.baselineAccuracy) * 100).toFixed(0)}% baseline.`
    : `Not in use yet. ${labelled.length} labelled ${labelled.length === 1 ? "reply" : "replies"} so far; it starts once there are enough of both kinds and it can beat guessing.`;

  const html = `
    <h1>Your week</h1>
    <p ${META}>${weekStart} to ${today}</p>

    <h2>What you ate</h2>
    ${dayRows ? `<table style="border-collapse:collapse;font-size:15px">${dayRows}</table>` : "<p>Nothing recorded this week.</p>"}

    <h2>What it cost</h2>
    <p>
      <strong>£${spent.toFixed(2)}</strong> of £${WEEKLY_BUDGET_GBP.toFixed(0)}, across ${cooked.length} ${cooked.length === 1 ? "meal" : "meals"}.<br>
      <span ${META}>£${till.toFixed(2)} at the till if you bought everything fresh.</span>
    </p>

    <h2>How it went</h2>
    <p>
      ${avgRating !== null ? `Average ${avgRating.toFixed(1)}/5 across ${rated.length} rated.` : "Nothing rated this week."}
      ${best ? `<br>Best: <strong>${esc(best.meal.name)}</strong> at ${best.history.rating}/5.` : ""}
      ${
        reasonCounts.size > 0
          ? `<br><span ${META}>Turned down: ${[...reasonCounts.entries()]
              .map(([r, n]) => `${DECLINE_LABELS[r as keyof typeof DECLINE_LABELS].toLowerCase()} x${n}`)
              .join(", ")}.</span>`
          : ""
      }
    </p>

    <h2>What the model learned</h2>
    <p ${META}>${esc(modelLine)}</p>
  `;

  const { error } = await m.resend.emails.send({
    from: m.from,
    to: m.to,
    subject: `Your week: £${spent.toFixed(2)} across ${cooked.length} ${cooked.length === 1 ? "meal" : "meals"}`,
    html,
  });

  return error ? { sent: false, reason: error.message } : { sent: true };
}
