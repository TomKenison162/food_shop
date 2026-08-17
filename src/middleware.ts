import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, deriveSessionToken, tokensMatch } from "@/lib/auth/session";

/**
 * Gates the whole app behind a single shared password, because once this is
 * deployed to a public URL anyone who finds it could otherwise delete meals
 * or trigger the pricing route and spend real API credits.
 *
 * Two route families are deliberately exempt, since both are reached
 * without a browser session and carry their own credentials:
 *  - /api/cron/*        — authenticated by the CRON_SECRET bearer token
 *  - /api/feedback/respond — clicked from the daily email, authenticated by
 *                            the HMAC signature in the URL
 *  - /api/pantry/missing   — same, for the "not got it" links beside each
 *                            pantry-covered ingredient
 *
 * Missing APP_PASSWORD is handled differently per environment, on purpose:
 * locally the gate opens (no setup needed to run `npm run dev`), but in
 * production it FAILS CLOSED with a 503. Forgetting to set it in Vercel
 * would otherwise silently publish an app where anyone could delete meals
 * or run up real pricing-API charges — a much worse outcome than downtime.
 */
const EXEMPT_PREFIXES = [
  "/api/cron/",
  "/api/feedback/respond",
  "/api/pantry/missing",
  "/login",
  "/api/login",
];

export async function middleware(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "APP_PASSWORD is not configured. Refusing to serve an unprotected deployment." },
        { status: 503 }
      );
    }
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;
  if (EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  const expected = await deriveSessionToken(password);
  if (cookie && tokensMatch(cookie, expected)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Everything except Next's own static assets and the generated PWA files.
   *
   * These must be excluded, not merely allowed through: a service worker
   * script that answers with a 307 to /login isn't JavaScript, so the
   * browser fails registration and the PWA silently stops working. The
   * PWA plugin emits several differently-named files (sw.js,
   * swe-worker-<hash>.js, workbox-<hash>.js, worker-<hash>.js,
   * fallback-<hash>.js) — note swe-worker- does NOT start with worker-, so
   * it needs its own entry. None of them expose data, so serving them
   * unauthenticated is correct.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|manifest\\.json|icon-|apple-touch-icon|sw\\.js|swe-worker-|workbox-|worker-|fallback-).*)",
  ],
};
