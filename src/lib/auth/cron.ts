import { NextRequest } from "next/server";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations. */
export function isAuthorizedCronRequest(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}
