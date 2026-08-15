import { createHmac, timingSafeEqual } from "crypto";

export interface FeedbackLinkParams {
  mealId: number;
  date: string; // YYYY-MM-DD
  dayOfWeek: number;
  isWeekend: boolean;
  temperatureC: number | null;
  accepted: boolean;
}

function secret(): string {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error("CRON_SECRET is not set — required to sign feedback links.");
  return s;
}

function canonicalString(p: FeedbackLinkParams): string {
  return [p.mealId, p.date, p.dayOfWeek, p.isWeekend, p.temperatureC ?? "null", p.accepted].join("|");
}

function sign(p: FeedbackLinkParams): string {
  return createHmac("sha256", secret()).update(canonicalString(p)).digest("hex");
}

/**
 * Builds a signed GET link for the daily email's Yes/No buttons. Context
 * (day of week, weekend, temperature) is embedded in the URL rather than
 * recomputed when clicked, so the training example reflects the day the
 * email was actually sent for, not whenever the click happens to land.
 */
export function buildFeedbackLink(appUrl: string, p: FeedbackLinkParams): string {
  const params = new URLSearchParams({
    mealId: String(p.mealId),
    date: p.date,
    dayOfWeek: String(p.dayOfWeek),
    isWeekend: String(p.isWeekend),
    temperatureC: p.temperatureC !== null ? String(p.temperatureC) : "",
    accepted: String(p.accepted),
    sig: sign(p),
  });
  return `${appUrl}/api/feedback/respond?${params.toString()}`;
}

export function verifyFeedbackLink(p: FeedbackLinkParams, sig: string): boolean {
  const expected = sign(p);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
