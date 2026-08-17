import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { pantryItems } from "@/lib/db/schema";
import { verifyPantryLink } from "@/lib/pantryLink";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

function htmlPage(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Pantry</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:system-ui,sans-serif;background:#030712;color:#f3f4f6;display:flex;
             align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}
        .card{max-width:32rem}
        h1{font-size:1.5rem;margin:0 0 .5rem}
        p{color:#9ca3af;line-height:1.5}
      </style>
    </head><body><div class="card">${body}</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * "I haven't actually got that" — the correction for the one place the
 * pantry can be confidently wrong.
 *
 * Stock is inferred rather than counted: cooking a meal banks the leftover
 * of a whole pack for every line, on the assumption the pack was bought. If
 * you already had the cumin and bought none, the app now believes in 340g of
 * it that doesn't exist. That error is the expensive direction, because an
 * over-stated pantry means the shopping list *omits* something and you get
 * home unable to cook. Under-stating only costs a duplicate jar.
 *
 * Deliberately does one UPDATE and nothing else. The feedback route is slow
 * because a decline triggers a whole re-plan; there is no reason for this to
 * inherit any of that.
 *
 * Exempt from the login gate (see src/middleware.ts), authenticated by the
 * HMAC signature that covers both the date and the ingredient name.
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const userId = Number(sp.get("user"));
  const date = sp.get("date") ?? "";
  const name = sp.get("name") ?? "";
  const sig = sp.get("sig") ?? "";

  if (!Number.isInteger(userId) || userId <= 0 || !date || !name) {
    return htmlPage("<p>That link looks malformed.</p>");
  }
  if (!verifyPantryLink(userId, date, name, sig)) return htmlPage("<p>That link isn't valid.</p>");

  const removed = await db
    .delete(pantryItems)
    .where(and(eq(pantryItems.userId, userId), eq(pantryItems.genericName, name)))
    .returning({ id: pantryItems.id });

  return htmlPage(
    removed.length > 0
      ? `<h1>Noted.</h1><p><strong>${esc(name)}</strong> is off the list, so it'll be on your next shop instead of being skipped.</p>`
      : `<h1>Already gone.</h1><p><strong>${esc(name)}</strong> wasn't being counted anyway.</p>`
  );
}
