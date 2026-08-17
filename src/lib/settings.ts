/**
 * Per-user settings moved into the `users` table when the app became
 * multi-user: there was nothing left to say about a user beyond who they
 * are and how they like their reminders, so a separate singleton table was
 * just somewhere for a missing user filter to hide.
 */
export { getPortionsSetting, setPortionsSetting, isPaused, pauseUntil } from "./users";
