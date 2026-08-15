export const SESSION_COOKIE = "fs_session";

/**
 * Derives the session token from APP_PASSWORD. The cookie holds this
 * digest rather than the password itself, and it can't be forged without
 * knowing APP_PASSWORD.
 *
 * Uses Web Crypto (not node:crypto) because this runs in Next.js
 * middleware, which executes on the Edge runtime where node builtins
 * aren't available.
 *
 * This is a deliberately simple single-user gate: one shared password, a
 * non-expiring token, no user accounts. It exists to stop a public URL
 * from letting anyone delete meals or spend real pricing-API credits — not
 * to be a multi-tenant auth system.
 */
export async function deriveSessionToken(password: string): Promise<string> {
  const data = new TextEncoder().encode(`food-shop-session:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish comparison; both values are fixed-length hex digests. */
export function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
