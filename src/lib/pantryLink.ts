import { createHmac, timingSafeEqual } from "crypto";

/**
 * Signs the per-ingredient "not got it" links in the daily email's
 * "Already in" list.
 *
 * Same HMAC approach as the feedback links, and for the same reason: these
 * are tapped from a mail client with no session, so they can't sit behind
 * the password gate. The ingredient name is inside the signature, so a valid
 * link can't be edited to zero a different item.
 *
 * One link per item rather than a form, because mail clients strip both
 * JavaScript and forms — a real tickbox that submits is not something an
 * email can do. Each tap costs a single UPDATE, which is why this stays
 * quick where the decline path (a full re-plan) does not.
 */
function secret(): string {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error("CRON_SECRET is not set — required to sign pantry links.");
  return s;
}

function sign(date: string, genericName: string): string {
  return createHmac("sha256", secret()).update(`pantry|${date}|${genericName}`).digest("hex");
}

export function buildPantryMissingLink(appUrl: string, date: string, genericName: string): string {
  const params = new URLSearchParams({ date, name: genericName, sig: sign(date, genericName) });
  return `${appUrl}/api/pantry/missing?${params.toString()}`;
}

export function verifyPantryLink(date: string, genericName: string, sig: string): boolean {
  const expected = sign(date, genericName);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(sig, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
