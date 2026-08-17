"use client";

/**
 * Which user the browser is acting for, from `?user=` on the page URL.
 *
 * The API layer refuses to guess (see requireUserParam) — but a UI has to
 * put *something* in the box, so the default lives here, in one visible
 * place, rather than being scattered as a fallback through the routes. That
 * keeps the loud-failure property where it matters: on the server, where a
 * wrong guess would write into someone else's data.
 *
 * Visit /?user=2 to swipe as a second person.
 */
export const DEFAULT_UI_USER_ID = 1;

export function currentUserId(): number {
  if (typeof window === "undefined") return DEFAULT_UI_USER_ID;
  const raw = new URLSearchParams(window.location.search).get("user");
  const id = Number(raw);
  return raw && Number.isInteger(id) && id > 0 ? id : DEFAULT_UI_USER_ID;
}

/** Appends `user=` to an API path, preserving any existing query string. */
export function withUser(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}user=${currentUserId()}`;
}
