import "dotenv/config";

/**
 * Local stand-in for Vercel Cron while the app isn't deployed yet. Polls
 * /api/cron/daily-reminder every 5 minutes; the route itself only actually
 * sends once it's 17:00 Europe/London (see src/app/api/cron/daily-reminder/route.ts),
 * so this is safe to leave running continuously. Run alongside `npm run dev`
 * and `npm run db:local-server`.
 */
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const POLL_INTERVAL_MS = 5 * 60 * 1000;

async function tick() {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[local-cron] CRON_SECRET is not set — skipping.");
    return;
  }
  try {
    const res = await fetch(`${APP_URL}/api/cron/daily-reminder`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const body = await res.json();
    if (body.skipped) {
      console.log(`[local-cron] ${new Date().toISOString()} — skipped: ${body.reason}`);
    } else {
      console.log(`[local-cron] ${new Date().toISOString()} — result:`, body);
    }
  } catch (err) {
    console.error("[local-cron] request failed:", err);
  }
}

console.log(`[local-cron] Polling ${APP_URL}/api/cron/daily-reminder every 5 minutes.`);
tick();
setInterval(tick, POLL_INTERVAL_MS);
