import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, deriveSessionToken } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

/**
 * In-memory failed-attempt counter, keyed by client IP. Deliberately not
 * persisted: this is a single-user app and a serverless instance recycling
 * (which resets the counter) is an acceptable weakening for something whose
 * real defence is a long random password. It exists to make online
 * brute-forcing impractical, not to be a complete lockout system.
 */
const attempts = new Map<string, { count: number; firstAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > WINDOW_MS) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count++;
  }
}

export async function POST(req: NextRequest) {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: "APP_PASSWORD is not configured." }, { status: 500 });
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  if (typeof body?.password !== "string" || body.password !== password) {
    recordFailure(ip);
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  attempts.delete(ip);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await deriveSessionToken(password), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
