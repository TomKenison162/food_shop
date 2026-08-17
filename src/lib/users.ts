import { and, eq } from "drizzle-orm";
import { db } from "./db/client";
import { users } from "./db/schema";
import { requireUserId } from "./userGuard";

export { requireUserId };

export type UserRecord = typeof users.$inferSelect;

/**
 * Multi-user rules, in one place.
 *
 * Every table that expresses a preference or a history is scoped to a user;
 * the recipe catalogue is not. The danger in that arrangement is not
 * difficulty, it is silence: a single query that forgets its user filter
 * lets one person rate another's meals or drain their pantry, and nothing
 * visibly breaks for weeks.
 *
 * So the design refuses to be quiet about it:
 *  - the columns are NOT NULL with no database default, so a forgotten user
 *    is rejected by Postgres rather than defaulting to user 1
 *  - every per-user function takes `userId` as a required argument, so a
 *    forgotten user is a TypeScript error rather than a runtime surprise
 *  - `requireUserId` catches anything that slips through both, loudly
 *
 * There is deliberately no "current user" global and no fallback. Anything
 * that cannot say who it is acting for is a bug, not a default.
 */

/** Everyone who should receive a daily reminder. */
export async function activeUsers(): Promise<UserRecord[]> {
  return db.select().from(users).where(eq(users.isActive, true)).orderBy(users.id);
}

export async function getUser(userId: number): Promise<UserRecord | undefined> {
  requireUserId(userId, "getUser");
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}

export async function getUserByEmail(email: string): Promise<UserRecord | undefined> {
  return db.query.users.findFirst({ where: eq(users.email, email.toLowerCase()) });
}

/** Portions for a user. Throws rather than assuming, per the rules above. */
export async function getPortionsSetting(userId: number): Promise<1 | 2> {
  requireUserId(userId, "getPortionsSetting");
  const user = await getUser(userId);
  if (!user) throw new Error(`No such user: ${userId}`);
  return user.portions === 1 ? 1 : 2;
}

export async function setPortionsSetting(userId: number, portions: 1 | 2): Promise<void> {
  requireUserId(userId, "setPortionsSetting");
  await db.update(users).set({ portions }).where(eq(users.id, userId));
}

/** True when this user's reminders are suspended through `date`. */
export async function isPaused(userId: number, date: string): Promise<boolean> {
  requireUserId(userId, "isPaused");
  const user = await getUser(userId);
  return user?.pausedUntil !== null && user?.pausedUntil !== undefined && date <= user.pausedUntil;
}

export async function pauseUntil(userId: number, date: string | null): Promise<void> {
  requireUserId(userId, "pauseUntil");
  await db.update(users).set({ pausedUntil: date }).where(eq(users.id, userId));
}

/**
 * Copies one user's approved queue to another.
 *
 * Used to onboard someone without making them swipe 137 dishes: family
 * tastes overlap heavily, so inheriting a working queue and correcting it
 * later beats starting from nothing. Their history, pantry and model stay
 * entirely their own — only the starting preferences are shared, and from
 * the first reply the two diverge.
 */
export async function copyApprovals(fromUserId: number, toUserId: number): Promise<number> {
  requireUserId(fromUserId, "copyApprovals(from)");
  requireUserId(toUserId, "copyApprovals(to)");
  if (fromUserId === toUserId) throw new Error("copyApprovals: source and target are the same user.");

  const { approvedQueue } = await import("./db/schema");
  const source = await db
    .select({ mealId: approvedQueue.mealId })
    .from(approvedQueue)
    .where(eq(approvedQueue.userId, fromUserId));
  if (source.length === 0) return 0;

  const existing = await db
    .select({ mealId: approvedQueue.mealId })
    .from(approvedQueue)
    .where(eq(approvedQueue.userId, toUserId));
  const already = new Set(existing.map((r) => r.mealId));

  const toInsert = source.filter((r) => !already.has(r.mealId)).map((r) => ({ userId: toUserId, mealId: r.mealId }));
  if (toInsert.length === 0) return 0;

  await db.insert(approvedQueue).values(toInsert);
  return toInsert.length;
}

/** Convenience for the many queries shaped "this user's rows in this table". */
export function forUser<T extends { userId: unknown }>(table: T, userId: number, context: string) {
  return eq(table.userId as never, requireUserId(userId, context));
}

export { and };
