import { createHmac, timingSafeEqual } from "crypto";
import type { DeclineReason } from "./declineReasons";

/**
 * What a click from the daily email means.
 *  - accept:  cook the meal that was led with
 *  - choose:  cook one of the alternatives instead (a comparative preference)
 *  - decline: none of them, with a reason
 */
export type FeedbackAction = "accept" | "choose" | "decline";

export interface FeedbackLinkParams {
  mealId: number;
  date: string; // YYYY-MM-DD
  action: FeedbackAction;
  /** Only meaningful for `decline`. */
  reason?: DeclineReason | null;
}

function secret(): string {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error("CRON_SECRET is not set — required to sign feedback links.");
  return s;
}

/**
 * The reason is inside the signed payload, not a free parameter alongside it
 * — otherwise anyone holding a valid decline link could swap the reason and
 * quietly rewrite a training label.
 */
function canonicalString(p: FeedbackLinkParams): string {
  return [p.mealId, p.date, p.action, p.reason ?? ""].join("|");
}

function sign(p: FeedbackLinkParams): string {
  return createHmac("sha256", secret()).update(canonicalString(p)).digest("hex");
}

/**
 * Builds a signed GET link for the daily email's buttons. Only identifiers
 * travel in the URL — the ML feature context lives on the meal_history and
 * meal_offers rows for that date, snapshotted when the suggestion was made,
 * so clicking days later still records the right context.
 */
export function buildFeedbackLink(appUrl: string, p: FeedbackLinkParams): string {
  const params = new URLSearchParams({
    mealId: String(p.mealId),
    date: p.date,
    action: p.action,
    sig: sign(p),
  });
  if (p.reason) params.set("reason", p.reason);
  return `${appUrl}/api/feedback/respond?${params.toString()}`;
}

export function verifyFeedbackLink(p: FeedbackLinkParams, sig: string): boolean {
  const expected = sign(p);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
